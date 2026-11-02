// Command sencho-recovery-probe reports the identity of one directory as the
// kernel sees it: the filesystem device, the inode, and the directory's own
// owner and mode.
//
// Sencho uses it as the generation token of a mounted storage root. Docker's
// volume CreatedAt has one-second resolution, so a volume removed and recreated
// inside the same second keeps its timestamp; the root's device and inode do
// not survive that recreate. The probe reads metadata only, never file content,
// and it runs inside the recovery helper with the root mounted read-only.
//
// Usage: sencho-recovery-probe <path>
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
}

func main() {
	if len(os.Args) != 2 {
		fail("usage: sencho-recovery-probe <path>")
	}
	var st syscall.Stat_t
	if err := syscall.Stat(os.Args[1], &st); err != nil {
		fail(err.Error())
	}
	out, err := json.Marshal(report{
		Device: int64(st.Dev),
		Inode:  st.Ino,
		UID:    st.Uid,
		GID:    st.Gid,
		Mode:   uint32(st.Mode),
	})
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
