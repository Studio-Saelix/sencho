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
// Usage: sencho-recovery-probe <path> [--work-dirs]
//
// --work-dirs also lists the root entries whose names start with the restore work
// directory prefix (a file counts as well as a directory, as it does for `swap
// prepare`), so a preview can refuse a volume the next swap would refuse. It reads
// and sorts the whole root listing before it caps the answer, so only the caller
// that needs it asks.
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
}

// maxReportedWorkDirs bounds the listing: one is enough to refuse, a few name
// the cause, and a volume full of them is not worth a long line.
const maxReportedWorkDirs = 8

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "swap" {
		runSwap(os.Args[2:])
		return
	}
	listWorkDirs := len(os.Args) == 3 && os.Args[2] == "--work-dirs"
	if len(os.Args) != 2 && !listWorkDirs {
		fail("usage: sencho-recovery-probe <path> [--work-dirs]")
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
		Device: int64(st.Dev),
		Inode:  st.Ino,
		UID:    st.Uid,
		GID:    st.Gid,
		Mode:   uint32(st.Mode),
		Free:   fs.Bavail * uint64(fs.Bsize),
	}
	if listWorkDirs {
		names, err := listWorkDirNames(os.Args[1])
		if err != nil {
			fail(err.Error())
		}
		result.WorkDirs = &names
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
