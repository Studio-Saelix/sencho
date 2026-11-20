package main

// The guard is what makes a host-directory capture or swap run against the
// directory Sencho proved, so its refusal and its exec are pinned here, along
// with the nested-mount reader and the birth-time decoding the generation token
// depends on.

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func identityOf(t *testing.T, path string) (string, string) {
	t.Helper()
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	return strconv.FormatUint(uint64(st.Dev), 10), strconv.FormatUint(st.Ino, 10)
}

func TestParseGuardArgs(t *testing.T) {
	request, err := parseGuardArgs([]string{"--root", "/data", "--expect", "64768:1234", "--", "/restic", "backup", "/data"})
	if err != nil {
		t.Fatal(err)
	}
	if request.root != "/data" || request.expectDev != "64768" || request.expectIno != "1234" {
		t.Fatalf("unexpected request %+v", request)
	}
	if !reflect.DeepEqual(request.argv, []string{"/restic", "backup", "/data"}) {
		t.Fatalf("unexpected argv %v", request.argv)
	}

	refused := [][]string{
		{},
		{"--root", "/data", "--", "/restic"},
		{"--root", "/data", "--expect", "1:2"},
		{"--root", "/data", "--expect", "1-2", "--", "/restic"},
		{"--root", "/data", "--expect", "-1:2", "--", "/restic"},
		{"--root", "/data", "--expect", "1:2", "--", "restic"},
		{"--root", "/data", "--expect", "1:2", "--bogus", "--", "/restic"},
		{"--expect", "1:2", "--", "/restic"},
	}
	for _, args := range refused {
		if _, err := parseGuardArgs(args); err == nil {
			t.Fatalf("expected %v to be refused", args)
		}
	}
}

func TestCheckGuardRootMatchesOnlyTheProvenDirectory(t *testing.T) {
	root := t.TempDir()
	dev, ino := identityOf(t, root)
	if err := checkGuardRoot(guardRequest{root: root, expectDev: dev, expectIno: ino, argv: []string{"/x"}}); err != nil {
		t.Fatalf("matching root refused: %v", err)
	}

	other := t.TempDir()
	if err := checkGuardRoot(guardRequest{root: other, expectDev: dev, expectIno: ino, argv: []string{"/x"}}); err == nil {
		t.Fatal("a different directory passed the guard")
	}

	// A directory replaced by a symlink to the proven one is refused: the guard
	// does not follow the link, so the swap cannot be redirected through it.
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "root")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if err := checkGuardRoot(guardRequest{root: link, expectDev: dev, expectIno: ino, argv: []string{"/x"}}); err == nil {
		t.Fatal("a symlink to the proven root passed the guard")
	}

	// The same directory recreated under the same name has a new inode.
	recreated := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(recreated, 0o755); err != nil {
		t.Fatal(err)
	}
	rdev, rino := identityOf(t, recreated)
	if err := os.Remove(recreated); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(t.TempDir(), "spacer"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(recreated, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, nino := identityOf(t, recreated); nino == rino {
		t.Skip("the filesystem reused the inode; nothing to prove here")
	}
	if err := checkGuardRoot(guardRequest{root: recreated, expectDev: rdev, expectIno: rino, argv: []string{"/x"}}); err == nil {
		t.Fatal("a recreated directory passed the guard")
	}

	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	fdev, fino := identityOf(t, file)
	if err := checkGuardRoot(guardRequest{root: file, expectDev: fdev, expectIno: fino, argv: []string{"/x"}}); err == nil {
		t.Fatal("a file passed the guard as a root")
	}
}

func TestGuardExecsTheCommandAfterAMatch(t *testing.T) {
	root := t.TempDir()
	dev, ino := identityOf(t, root)
	var gotArgv0 string
	var gotArgv []string
	previous := execProgram
	execProgram = func(argv0 string, argv []string, env []string) error {
		gotArgv0, gotArgv = argv0, argv
		return nil
	}
	defer func() { execProgram = previous }()
	runGuard([]string{"--root", root, "--expect", dev + ":" + ino, "--", "/restic", "backup", "/data"})
	if gotArgv0 != "/restic" || !reflect.DeepEqual(gotArgv, []string{"/restic", "backup", "/data"}) {
		t.Fatalf("guard ran %q %v", gotArgv0, gotArgv)
	}
}

func TestNestedMountsListsOnlyMountsBelowTheRoot(t *testing.T) {
	mountinfo := strings.Join([]string{
		"22 1 0:21 / / rw - overlay overlay rw",
		"30 22 8:1 /srv/app /data ro,relatime - ext4 /dev/sda1 rw",
		"31 30 0:40 / /data/cache rw - tmpfs tmpfs rw",
		"32 30 8:2 / /data/disk\\040two rw - ext4 /dev/sdb rw",
		"33 22 0:41 / /database rw - tmpfs tmpfs rw",
		"34 31 0:42 / /data/cache/deeper rw - tmpfs tmpfs rw",
		"35 30 0:43 / /data/cache rw - tmpfs tmpfs rw",
	}, "\n")
	mounts, truncated, err := nestedMounts("/data", strings.NewReader(mountinfo))
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("unexpected truncation")
	}
	want := []string{"cache", "cache/deeper", "disk two"}
	if !reflect.DeepEqual(mounts, want) {
		t.Fatalf("got %v, want %v", mounts, want)
	}
}

func TestNestedMountsCapsTheAnswer(t *testing.T) {
	var lines []string
	for i := 0; i < maxReportedMounts+5; i++ {
		lines = append(lines, "40 30 0:50 / /data/m"+strconv.Itoa(1000+i)+" rw - tmpfs tmpfs rw")
	}
	mounts, truncated, err := nestedMounts("/data/", strings.NewReader(strings.Join(lines, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(mounts) != maxReportedMounts {
		t.Fatalf("got %d mounts, truncated=%v", len(mounts), truncated)
	}
}

func TestNestedMountsRefusesAnUnreadableTable(t *testing.T) {
	if _, _, err := nestedMounts("/data", strings.NewReader("garbage\n")); err == nil {
		t.Fatal("an unreadable mountinfo line was accepted")
	}
}

func TestParseStatxBirthTime(t *testing.T) {
	buf := make([]byte, statxSize)
	if _, ok := parseStatxBirthTime(buf); ok {
		t.Fatal("a buffer without the btime bit reported a birth time")
	}
	binary.LittleEndian.PutUint32(buf[statxMaskAt:], statxBtime)
	binary.LittleEndian.PutUint64(buf[statxBtimeAt:], 1700000000)
	binary.LittleEndian.PutUint32(buf[statxBtimeAt+8:], 42)
	got, ok := parseStatxBirthTime(buf)
	if !ok || got != "1700000000.000000042" {
		t.Fatalf("got %q %v", got, ok)
	}
	// The bit set with a zero time is a filesystem that does not really know.
	zero := make([]byte, statxSize)
	binary.LittleEndian.PutUint32(zero[statxMaskAt:], statxBtime)
	if _, ok := parseStatxBirthTime(zero); ok {
		t.Fatal("a zero birth time was reported")
	}
}

func TestBirthTimeOfARealDirectoryIsWellFormedWhenPresent(t *testing.T) {
	got, ok := birthTime(t.TempDir())
	if !ok {
		t.Skip("this filesystem reports no birth time")
	}
	sec, nsec, found := strings.Cut(got, ".")
	if !found || !isDecimal(sec) || len(nsec) != 9 || !isDecimal(nsec) {
		t.Fatalf("malformed birth time %q", got)
	}
}
