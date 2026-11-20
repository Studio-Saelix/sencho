package main

// The guard closes the window between Sencho's identity proof and the command
// that reads or writes a host directory.
//
// Docker resolves a bind source when a container starts. Sencho proves that the
// host path it is about to bind is the directory it authorized (same device and
// inode as its own view), but the proof runs in one container and the capture or
// swap in another, and a directory or symlink swapped in between would be bound
// instead. The guard runs first in the working container itself: it stats the
// mounted root, refuses when its identity is not the proven one, and otherwise
// execs the real command in the same process. A bind mount cannot change under a
// running container, so the checked directory is the one the command sees.

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// guardRefusedExit is the exit code of a refused guard. restic and the probe use
// other codes, so Sencho can tell "the directory is not the proven one" from a
// command that ran and failed.
const guardRefusedExit = 86

// maxReportedMounts bounds the nested-mount answer. A root with more mounts
// below it than this is refused by Sencho rather than captured.
const maxReportedMounts = 64

type guardRequest struct {
	root      string
	expectDev string
	expectIno string
	argv      []string
}

func parseGuardArgs(args []string) (guardRequest, error) {
	var request guardRequest
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--root":
			if i+1 >= len(args) {
				return request, fmt.Errorf("--root needs a value")
			}
			request.root = args[i+1]
			i++
		case "--expect":
			if i+1 >= len(args) {
				return request, fmt.Errorf("--expect needs a value")
			}
			dev, ino, ok := strings.Cut(args[i+1], ":")
			if !ok || !isDecimal(dev) || !isDecimal(ino) {
				return request, fmt.Errorf("--expect must be <dev>:<ino> in decimal")
			}
			request.expectDev, request.expectIno = dev, ino
			i++
		case "--":
			request.argv = args[i+1:]
			i = len(args)
		default:
			return request, fmt.Errorf("unknown guard argument %q", args[i])
		}
	}
	if request.root == "" || request.expectDev == "" || len(request.argv) == 0 {
		return request, fmt.Errorf("usage: guard --root <mount> --expect <dev>:<ino> -- <argv...>")
	}
	if !filepath.IsAbs(request.argv[0]) {
		return request, fmt.Errorf("guard runs only an absolute program path")
	}
	return request, nil
}

func isDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// checkGuardRoot answers nil when root is a directory with the expected identity.
func checkGuardRoot(request guardRequest) error {
	var st syscall.Stat_t
	if err := lstat(request.root, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return fmt.Errorf("root is not a directory")
	}
	dev := strconv.FormatUint(uint64(st.Dev), 10)
	ino := strconv.FormatUint(st.Ino, 10)
	if dev != request.expectDev || ino != request.expectIno {
		return fmt.Errorf("root identity mismatch")
	}
	return nil
}

// exec is a seam: a test replaces it to see what the guard would run.
var execProgram = func(argv0 string, argv []string, env []string) error {
	return syscall.Exec(argv0, argv, env)
}

func runGuard(args []string) {
	request, err := parseGuardArgs(args)
	if err != nil {
		fail(err.Error())
	}
	if err := checkGuardRoot(request); err != nil {
		out := fmt.Sprintf(`{"error":%q,"guard":"refused"}`, err.Error())
		fmt.Println(out)
		os.Exit(guardRefusedExit)
	}
	// stdin, stdout and stderr are inherited by exec, so restic still reads its
	// password from the attached stdin.
	if err := execProgram(request.argv[0], request.argv, os.Environ()); err != nil {
		fail(err.Error())
	}
}

// --- Nested mounts ----------------------------------------------------------

// nestedMounts lists the mount points strictly below root from a mountinfo
// stream, relative to root, sorted and deduplicated. The answer is capped at
// maxReportedMounts with truncated set when more exist.
func nestedMounts(root string, mountinfo io.Reader) ([]string, bool, error) {
	clean := filepath.Clean(root)
	prefix := clean + "/"
	if clean == "/" {
		prefix = "/"
	}
	seen := map[string]bool{}
	scanner := bufio.NewScanner(mountinfo)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			return nil, false, fmt.Errorf("unreadable mountinfo line")
		}
		point := unescapeMountPath(fields[4])
		if point == clean || !strings.HasPrefix(point, prefix) {
			continue
		}
		rel := strings.TrimPrefix(point, prefix)
		if rel != "" {
			seen[rel] = true
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) > maxReportedMounts {
		return names[:maxReportedMounts], true, nil
	}
	return names, false, nil
}

// unescapeMountPath decodes the octal escapes mountinfo uses for space, tab,
// newline and backslash.
func unescapeMountPath(value string) string {
	if !strings.Contains(value, `\`) {
		return value
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			if code, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(code))
				i += 3
				continue
			}
		}
		b.WriteByte(value[i])
	}
	return b.String()
}

// --- Birth time ---------------------------------------------------------------

const (
	atFdcwd      = -100
	statxBtime   = 0x800
	statxSize    = 256
	statxMaskAt  = 0
	statxBtimeAt = 80
)

// birthTime reads the directory's birth time with a raw statx call, so the
// module needs no dependency. It answers false when the kernel, the
// architecture or the filesystem does not report one.
func birthTime(path string) (string, bool) {
	if sysStatx < 0 {
		return "", false
	}
	pathBytes, err := syscall.BytePtrFromString(path)
	if err != nil {
		return "", false
	}
	var buf [statxSize]byte
	dirfd := atFdcwd
	_, _, errno := syscall.Syscall6(
		uintptr(sysStatx),
		uintptr(dirfd),
		uintptr(unsafe.Pointer(pathBytes)),
		0,
		statxBtime,
		uintptr(unsafe.Pointer(&buf[0])),
		0,
	)
	if errno != 0 {
		return "", false
	}
	return parseStatxBirthTime(buf[:])
}

// parseStatxBirthTime reads stx_mask and stx_btime from a statx buffer. Both
// supported architectures are little endian.
func parseStatxBirthTime(buf []byte) (string, bool) {
	if len(buf) < statxBtimeAt+12 {
		return "", false
	}
	mask := binary.LittleEndian.Uint32(buf[statxMaskAt:])
	if mask&statxBtime == 0 {
		return "", false
	}
	sec := int64(binary.LittleEndian.Uint64(buf[statxBtimeAt:]))
	nsec := binary.LittleEndian.Uint32(buf[statxBtimeAt+8:])
	if sec == 0 && nsec == 0 {
		return "", false
	}
	return fmt.Sprintf("%d.%09d", sec, nsec), true
}
