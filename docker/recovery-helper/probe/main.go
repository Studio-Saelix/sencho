// Command sencho-recovery-probe reports the identity of one directory as the
// kernel sees it: the filesystem device, the inode, the directory's own owner
// and mode, and the free space available to it.
//
// Sencho uses it as the generation token of a mounted storage root. Docker's
// volume CreatedAt has one-second resolution, so a volume removed and recreated
// inside the same second keeps its timestamp; the root's device and inode do
// not survive that recreate. The probe reads metadata and directory names only,
// never file content, and it runs inside the recovery helper with the root
// mounted read-only.
//
// Usage: sencho-recovery-probe <path> [--work-dirs | --mounts]
//
// --work-dirs also lists the root entries named like one of Sencho's restore work
// directories (the prefix plus an intent UUID; a file counts as well as a
// directory, as it does for `swap prepare`), so a preview can refuse a volume the
// next swap would refuse. A name with the prefix and any other shape is user data
// and is not listed. It reads and sorts the whole root listing before it caps the
// answer, so only the caller that needs it asks.
//
// --mounts also lists the mount points strictly below <path>, read from
// /proc/self/mountinfo, so Sencho can record a nested mount it will not capture
// instead of calling the root complete. It needs the root bound recursively.
//
// The device and inode are also written as decimal strings (`dev_s`, `ino_s`),
// because a JSON number loses precision past 2^53 and an identity comparison
// must be exact. `btime` is the birth time from a raw statx call, present only
// when the filesystem reports one.
//
//	sencho-recovery-probe guard --root <mount> --expect <dev>:<ino> -- <argv...>
//
// guard stats the mounted root inside the container, refuses with exit 86 when
// its identity is not the one Sencho proved, and otherwise execs <argv> in place,
// so the command runs against the directory that was checked (see guard.go).
//
//	sencho-recovery-probe swap <prepare|commit|status|rollback|cleanup> --root <path> --id <intent>
//
// Output: one JSON object on stdout. Exit 0 on success, 1 with an {"error"}
// object on failure.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"syscall"
)

type report struct {
	Device int64  `json:"dev"`
	Inode  uint64 `json:"ino"`
	UID    uint32 `json:"uid"`
	GID    uint32 `json:"gid"`
	Mode   uint32 `json:"mode"`
	// Available bytes for a write by an unprivileged process. The overwrite
	// preview uses it to refuse a restore that cannot fit next to the live data.
	Free uint64 `json:"free"`
	// Names at the root under the work directory prefix. Present only with
	// --work-dirs (a pointer, so an empty answer is `[]` and not absent), so a
	// plain probe stays one stat and one statfs.
	WorkDirs *[]string `json:"work_dirs,omitempty"`
	// The device and inode as exact decimal strings.
	DeviceString string `json:"dev_s"`
	InodeString  string `json:"ino_s"`
	// Birth time as `<seconds>.<nanoseconds>`, absent when the filesystem has none.
	BirthTime *string `json:"btime,omitempty"`
	// Mount points strictly below the root, relative to it. Present only with --mounts.
	Mounts          *[]string `json:"mounts,omitempty"`
	MountsTruncated bool      `json:"mounts_truncated,omitempty"`
}

// maxReportedWorkDirs bounds the listing: one is enough to refuse, a few name
// the cause, and a volume full of them is not worth a long line.
const maxReportedWorkDirs = 8

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "swap" {
		runSwap(os.Args[2:])
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "guard" {
		runGuard(os.Args[2:])
		return
	}
	listWorkDirs := len(os.Args) == 3 && os.Args[2] == "--work-dirs"
	listMounts := len(os.Args) == 3 && os.Args[2] == "--mounts"
	if len(os.Args) != 2 && !listWorkDirs && !listMounts {
		fail("usage: sencho-recovery-probe <path> [--work-dirs | --mounts]")
	}
	var st syscall.Stat_t
	if err := syscall.Stat(os.Args[1], &st); err != nil {
		fail(err.Error())
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(os.Args[1], &fs); err != nil {
		fail(err.Error())
	}
	result := report{
		Device:       int64(st.Dev),
		Inode:        st.Ino,
		UID:          st.Uid,
		GID:          st.Gid,
		Mode:         uint32(st.Mode),
		Free:         fs.Bavail * uint64(fs.Bsize),
		DeviceString: strconv.FormatUint(uint64(st.Dev), 10),
		InodeString:  strconv.FormatUint(st.Ino, 10),
	}
	if btime, ok := birthTime(os.Args[1]); ok {
		result.BirthTime = &btime
	}
	if listWorkDirs {
		names, err := listWorkDirNames(os.Args[1])
		if err != nil {
			fail(err.Error())
		}
		result.WorkDirs = &names
	}
	if listMounts {
		file, err := os.Open("/proc/self/mountinfo")
		if err != nil {
			fail(err.Error())
		}
		mounts, truncated, err := nestedMounts(os.Args[1], file)
		file.Close()
		if err != nil {
			fail(err.Error())
		}
		result.Mounts = &mounts
		result.MountsTruncated = truncated
	}
	out, err := json.Marshal(result)
	if err != nil {
		fail(err.Error())
	}
	fmt.Println(string(out))
}

func fail(message string) {
	out, _ := json.Marshal(map[string]string{"error": message})
	fmt.Println(string(out))
	os.Exit(1)
}
