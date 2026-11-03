package main

// The swap probe is the only thing that moves live data during an overwrite, so
// its guarantees are pinned here: every rename count is interrupted and resumed
// in both directions, a name that overlaps is handled, a foreign change is
// called inconsistent rather than guessed at, symlinks are moved rather than
// followed, and the root's own owner and mode are the snapshot's.

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

const testIntent = "4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d"

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// setupVolume builds a volume root with `originals` and a staged restore with
// `incoming`, plus the snapshot root directory whose metadata the swap applies.
func setupVolume(t *testing.T, originals, incoming map[string]string) swapRequest {
	t.Helper()
	root := t.TempDir()
	for name, content := range originals {
		writeFile(t, filepath.Join(root, name), content)
	}
	request := swapRequest{Root: root, ID: testIntent}
	workDir := filepath.Join(root, workDirPrefix+testIntent)
	snapshotRoot := filepath.Join(workDir, incomingDirName, snapshotRootName)
	if err := os.MkdirAll(snapshotRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range incoming {
		writeFile(t, filepath.Join(snapshotRoot, name), content)
	}
	// A distinctive root metadata the swap must carry onto the volume root.
	if err := os.Chmod(snapshotRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	return request
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func volumeNames(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Name() == workDirPrefix+testIntent {
			continue
		}
		names = append(names, entry.Name())
	}
	return names
}

func TestPrepareCommitAndCleanup(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original", "conf/keep.txt": "original-config"},
		map[string]string{"db.bin": "restored", "new.txt": "restored-new"},
	)
	report, err := swapPrepare(request)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if report.Status != statusPlanned {
		t.Fatalf("prepare status = %s", report.Status)
	}
	// Idempotent: a second prepare answers the journal, not a new plan.
	again, err := swapPrepare(request)
	if err != nil {
		t.Fatalf("second prepare: %v", err)
	}
	if again.Status != statusPlanned || len(again.Originals) != 2 || len(again.Incoming) != 2 {
		t.Fatalf("second prepare = %+v", again)
	}

	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got := readFile(t, filepath.Join(request.Root, "db.bin")); got != "restored" {
		t.Fatalf("db.bin = %q, want the restored bytes", got)
	}
	if got := readFile(t, filepath.Join(request.Root, "new.txt")); got != "restored-new" {
		t.Fatalf("new.txt = %q", got)
	}
	if _, err := os.Stat(filepath.Join(request.Root, "conf")); !os.IsNotExist(err) {
		t.Fatalf("the original conf directory is still live: %v", err)
	}
	// The original bytes are still inside the work directory until cleanup.
	original := filepath.Join(request.Root, workDirPrefix+testIntent, originalDirName, "db.bin")
	if got := readFile(t, original); got != "original" {
		t.Fatalf("original backup = %q", got)
	}

	// Root metadata is the snapshot root's.
	var rootStat, snapshotStat syscall.Stat_t
	if err := syscall.Stat(request.Root, &rootStat); err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(request.Root, workDirPrefix+testIntent, incomingDirName, snapshotRootName)
	if err := syscall.Stat(snapshot, &snapshotStat); err != nil {
		t.Fatal(err)
	}
	if rootStat.Mode&0o7777 != 0o750 {
		t.Fatalf("root mode = %o, want 750", rootStat.Mode&0o7777)
	}
	if rootStat.Uid != snapshotStat.Uid || rootStat.Gid != snapshotStat.Gid {
		t.Fatalf("root owner = %d:%d, want %d:%d", rootStat.Uid, rootStat.Gid, snapshotStat.Uid, snapshotStat.Gid)
	}

	// Commit and cleanup are idempotent.
	if report, err := swapCommit(request); err != nil || report.Status != statusSwapped {
		t.Fatalf("second commit = %+v, %v", report, err)
	}
	if report, err := swapCleanup(request); err != nil || report.Status != statusCleaned {
		t.Fatalf("cleanup = %+v, %v", report, err)
	}
	if _, err := os.Stat(filepath.Join(request.Root, workDirPrefix+testIntent)); !os.IsNotExist(err) {
		t.Fatalf("work directory survived cleanup: %v", err)
	}
	if report, err := swapCleanup(request); err != nil || report.Status != statusCleaned {
		t.Fatalf("second cleanup = %+v, %v", report, err)
	}
}

// interruptAt stops a commit after `budget` renames, then resumes it or rolls
// it back. Every resume must end in exactly one of the two proven states.
func TestInterruptedCommitResumesInBothDirections(t *testing.T) {
	originals := map[string]string{"db.bin": "original", "conf/keep.txt": "original-config"}
	incoming := map[string]string{"db.bin": "restored", "new.txt": "restored-new"}
	totalMoves := len(originals) + len(incoming)

	for budget := 0; budget <= totalMoves; budget++ {
		// Resume forward.
		forward := setupVolume(t, originals, incoming)
		if _, err := swapPrepare(forward); err != nil {
			t.Fatalf("prepare: %v", err)
		}
		moveBudgetForTests = budget
		if _, err := swapCommit(forward); err != nil && budget < totalMoves {
			t.Fatalf("budget %d: commit: %v", budget, err)
		}
		moveBudgetForTests = -1
		status, err := swapStatus(forward)
		if err != nil {
			t.Fatalf("budget %d: status: %v", budget, err)
		}
		if status.Status == statusInconsistent {
			t.Fatalf("budget %d: status is inconsistent", budget)
		}
		if _, err := swapCommit(forward); err != nil {
			t.Fatalf("budget %d: resumed commit: %v", budget, err)
		}
		if got := readFile(t, filepath.Join(forward.Root, "db.bin")); got != "restored" {
			t.Fatalf("budget %d: db.bin = %q", budget, got)
		}

		// Resume back. A commit that ran to completion is not interruptible any
		// more: past the commit point the only direction is roll forward.
		if budget == totalMoves {
			continue
		}
		back := setupVolume(t, originals, incoming)
		if _, err := swapPrepare(back); err != nil {
			t.Fatalf("prepare: %v", err)
		}
		moveBudgetForTests = budget
		if _, err := swapCommit(back); err != nil && budget < totalMoves {
			t.Fatalf("budget %d: commit before rollback: %v", budget, err)
		}
		moveBudgetForTests = -1
		if _, err := swapRollback(back); err != nil {
			t.Fatalf("budget %d: rollback: %v", budget, err)
		}
		if got := readFile(t, filepath.Join(back.Root, "db.bin")); got != "original" {
			t.Fatalf("budget %d: db.bin after rollback = %q", budget, got)
		}
		if got := readFile(t, filepath.Join(back.Root, "conf", "keep.txt")); got != "original-config" {
			t.Fatalf("budget %d: conf after rollback = %q", budget, got)
		}
		if _, err := os.Stat(filepath.Join(back.Root, "new.txt")); !os.IsNotExist(err) {
			t.Fatalf("budget %d: restored entry survived rollback: %v", budget, err)
		}
		if _, err := os.Stat(filepath.Join(back.Root, workDirPrefix+testIntent)); !os.IsNotExist(err) {
			t.Fatalf("budget %d: work directory survived rollback: %v", budget, err)
		}
	}
}

func TestNameOverlapIsRolledBackAndForward(t *testing.T) {
	originals := map[string]string{"data.txt": "original"}
	incoming := map[string]string{"data.txt": "restored"}
	request := setupVolume(t, originals, incoming)
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(request.Root, "data.txt")); got != "restored" {
		t.Fatalf("overlap after commit = %q", got)
	}

	// The same overlap, rolled back from every interruption point.
	for budget := 0; budget < 2; budget++ {
		request := setupVolume(t, originals, incoming)
		if _, err := swapPrepare(request); err != nil {
			t.Fatal(err)
		}
		moveBudgetForTests = budget
		if _, err := swapCommit(request); err != nil && budget < 2 {
			t.Fatalf("budget %d: commit: %v", budget, err)
		}
		moveBudgetForTests = -1
		if _, err := swapRollback(request); err != nil {
			t.Fatalf("budget %d: rollback: %v", budget, err)
		}
		if got := readFile(t, filepath.Join(request.Root, "data.txt")); got != "original" {
			t.Fatalf("budget %d: overlap after rollback = %q", budget, got)
		}
	}
}

func TestInconsistentStateIsDetected(t *testing.T) {
	// An original entry removed by someone else.
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(request.Root, "db.bin")); err != nil {
		t.Fatal(err)
	}
	status, err := swapStatus(request)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != statusInconsistent {
		t.Fatalf("status = %s, want inconsistent", status.Status)
	}
	if _, err := swapCommit(request); err == nil {
		t.Fatal("commit accepted an inconsistent volume")
	}

	// A foreign entry appears at the root after the plan was written.
	foreign := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if _, err := swapPrepare(foreign); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(foreign.Root, "someone-else.txt"), "x")
	status, err = swapStatus(foreign)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != statusInconsistent {
		t.Fatalf("foreign entry status = %s, want inconsistent", status.Status)
	}
}

func TestRefusesASecondWorkDirectory(t *testing.T) {
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if err := os.MkdirAll(filepath.Join(request.Root, workDirPrefix+"11111111-2222-3333-4444-555555555555"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := swapPrepare(request); err == nil {
		t.Fatal("prepare accepted a volume with another restore work directory")
	}
}

func TestSymlinksAndHardlinksSurviveTheRoundTrip(t *testing.T) {
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	link := filepath.Join(request.Root, "current")
	if err := os.Symlink("db.bin", link); err != nil {
		t.Fatal(err)
	}
	hardA := filepath.Join(request.Root, "hard-a")
	hardB := filepath.Join(request.Root, "hard-b")
	writeFile(t, hardA, "shared")
	if err := os.Link(hardA, hardB); err != nil {
		t.Fatal(err)
	}
	var beforeA syscall.Stat_t
	if err := syscall.Stat(hardA, &beforeA); err != nil {
		t.Fatal(err)
	}

	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	// Interrupt after three renames, so the symlink and the first hardlink have
	// crossed into the work directory, then put them back.
	moveBudgetForTests = 3
	if _, err := swapCommit(request); err != nil {
		t.Fatal(err)
	}
	moveBudgetForTests = -1
	if _, err := swapRollback(request); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("the symlink was followed or replaced: %v", err)
	}
	if target != "db.bin" {
		t.Fatalf("symlink target = %q", target)
	}
	var afterA, afterB syscall.Stat_t
	if err := syscall.Stat(hardA, &afterA); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Stat(hardB, &afterB); err != nil {
		t.Fatal(err)
	}
	if afterA.Ino != beforeA.Ino || afterB.Ino != beforeA.Ino {
		t.Fatalf("hardlink inode changed: %d -> %d / %d", beforeA.Ino, afterA.Ino, afterB.Ino)
	}
}

func TestRootMetadataIsAppliedAfterCommit(t *testing.T) {
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	snapshot := filepath.Join(request.Root, workDirPrefix+testIntent, incomingDirName, snapshotRootName)
	want := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	if err := os.Chtimes(snapshot, want, want); err != nil {
		t.Fatal(err)
	}
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatal(err)
	}
	var st syscall.Stat_t
	if err := syscall.Stat(request.Root, &st); err != nil {
		t.Fatal(err)
	}
	if got := time.Unix(st.Mtim.Sec, st.Mtim.Nsec).Truncate(time.Second); !got.Equal(want) {
		t.Fatalf("root mtime = %s, want %s", got, want)
	}
}

func TestCommitIntoAnEmptyVolume(t *testing.T) {
	request := setupVolume(t, map[string]string{}, map[string]string{"new.txt": "restored"})
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	report, err := swapCommit(request)
	if err != nil {
		t.Fatalf("commit into an empty volume: %v", err)
	}
	if report.Status != statusSwapped {
		t.Fatalf("report = %+v", report)
	}
	if got := readFile(t, filepath.Join(request.Root, "new.txt")); got != "restored" {
		t.Fatalf("new.txt = %q", got)
	}
	if _, err := swapCleanup(request); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}

func TestCleanupRefusesAnIncompleteSwap(t *testing.T) {
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	if _, err := swapCleanup(request); err == nil {
		t.Fatal("cleanup removed a work directory before the swap committed")
	}
}

// A run that moved every entry but did not record the commit must not answer
// "swapped": the caller would delete the originals before the root metadata was
// applied. It answers metadata_pending, and only a completed commit commits.
func TestAllMovesWithoutCommitMarkerAreNotSwapped(t *testing.T) {
	originals := map[string]string{"a.txt": "original"}
	incoming := map[string]string{"a.txt": "restored", "b.txt": "restored-new"}
	volume := setupVolume(t, originals, incoming)
	if _, err := swapPrepare(volume); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	writeCommitMarkerForTests = false
	if _, err := swapCommit(volume); err != nil {
		t.Fatalf("commit: %v", err)
	}
	writeCommitMarkerForTests = true

	status, err := swapStatus(volume)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if status.Status != statusMetadataPending {
		t.Fatalf("status = %q, want %q", status.Status, statusMetadataPending)
	}
	// Cleanup refuses: the originals are still the only way back.
	if _, err := swapCleanup(volume); err == nil {
		t.Fatal("cleanup accepted a swap whose commit marker is missing")
	}

	if _, err := swapCommit(volume); err != nil {
		t.Fatalf("resumed commit: %v", err)
	}
	status, err = swapStatus(volume)
	if err != nil {
		t.Fatalf("status after commit: %v", err)
	}
	if status.Status != statusSwapped {
		t.Fatalf("status = %q, want %q", status.Status, statusSwapped)
	}
	if _, err := swapCleanup(volume); err != nil {
		t.Fatalf("cleanup after commit: %v", err)
	}
}

// An empty volume is a legitimate overwrite target: there is nothing to move
// away, and the commit must still apply the root metadata and mark the journal.
func TestEmptyVolumeCommits(t *testing.T) {
	volume := setupVolume(t, map[string]string{}, map[string]string{"only.txt": "restored"})
	if _, err := swapPrepare(volume); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := swapCommit(volume); err != nil {
		t.Fatalf("commit on an empty volume: %v", err)
	}
	if got := readFile(t, filepath.Join(volume.Root, "only.txt")); got != "restored" {
		t.Fatalf("only.txt = %q", got)
	}
	if _, err := swapCleanup(volume); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}
