package main

// The swap probe is the only thing that moves live data during an overwrite, so
// its guarantees are pinned here: every rename count is interrupted and resumed
// in both directions, a name that overlaps is handled, a foreign change is
// called inconsistent rather than guessed at, symlinks are moved rather than
// followed, and the root's own owner and mode are the snapshot's.

import (
	"bytes"
	"errors"
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

// After the commit the workloads run: a new root entry, or a restored entry they
// renamed or removed, is their progress. The committed journal still proves the
// swap, so status stays `swapped` and cleanup removes the originals and leaves
// the workloads' entries alone.
func TestACommittedSwapStaysCommittedWhenAWorkloadChangesTheRoot(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original", "conf/keep.txt": "original-config"},
		map[string]string{"db.bin": "restored", "new.txt": "restored-new"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	writeFile(t, filepath.Join(request.Root, "postmaster.pid"), "123")
	if err := os.Remove(filepath.Join(request.Root, "new.txt")); err != nil {
		t.Fatal(err)
	}
	if report, err := swapStatus(request); err != nil || report.Status != statusSwapped {
		t.Fatalf("status = %+v, %v; want swapped", report, err)
	}
	if report, err := swapCommit(request); err != nil || report.Status != statusSwapped {
		t.Fatalf("commit again = %+v, %v; want swapped", report, err)
	}
	if report, err := swapCleanup(request); err != nil || report.Status != statusCleaned {
		t.Fatalf("cleanup = %+v, %v", report, err)
	}
	if _, err := os.Stat(filepath.Join(request.Root, workDirPrefix+testIntent)); !os.IsNotExist(err) {
		t.Fatalf("work directory survived: %v", err)
	}
	if got := readFile(t, filepath.Join(request.Root, "postmaster.pid")); got != "123" {
		t.Fatalf("the workload's entry = %q", got)
	}
	if got := readFile(t, filepath.Join(request.Root, "db.bin")); got != "restored" {
		t.Fatalf("db.bin = %q", got)
	}
}

// Only the commit marker proves the swap: the same changes before it are foreign.
func TestTheSameChangesBeforeTheCommitStayInconsistent(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original"},
		map[string]string{"new.txt": "restored"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(request.Root, "postmaster.pid"), "123")
	if report, err := swapStatus(request); err != nil || report.Status != statusInconsistent {
		t.Fatalf("status = %+v, %v; want inconsistent", report, err)
	}
}

// The captured root's modification time is part of what the operator is told is
// restored. Removing the work directory moves the root's mtime, so cleanup has to
// set it again, and a repeated cleanup must not, because the application may have
// written to the root by then.
func TestCleanupKeepsTheCapturedRootMtime(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original"},
		map[string]string{"db.bin": "restored"},
	)
	snapshot := filepath.Join(request.Root, workDirPrefix+testIntent, incomingDirName, snapshotRootName)
	captured := time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC)
	if err := os.Chtimes(snapshot, captured, captured); err != nil {
		t.Fatal(err)
	}
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// The commit applies it too, so a cleanup that sets it again cannot hide a
	// commit that stopped doing so.
	committed, err := os.Stat(request.Root)
	if err != nil {
		t.Fatal(err)
	}
	if !committed.ModTime().Equal(captured) {
		t.Fatalf("root mtime after commit = %s, want the captured %s", committed.ModTime(), captured)
	}
	if _, err := swapCleanup(request); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	info, err := os.Stat(request.Root)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(captured) {
		t.Fatalf("root mtime after cleanup = %s, want the captured %s", info.ModTime(), captured)
	}

	// The application writes to the root after the restart; a second cleanup
	// answers `cleaned` and leaves that alone.
	written := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(request.Root, written, written); err != nil {
		t.Fatal(err)
	}
	if report, err := swapCleanup(request); err != nil || report.Status != statusCleaned {
		t.Fatalf("second cleanup = %+v, %v", report, err)
	}
	info, err = os.Stat(request.Root)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(written) {
		t.Fatalf("a repeated cleanup moved the root mtime to %s", info.ModTime())
	}
}

// The journal lives inside the work directory, so a clean-up that dies part way
// must not have deleted it while the originals are still on disk: with no journal
// the directory is unexplained, `cleanup` refuses it and `status` calls it
// inconsistent, and the operator's only way out restarts workloads next to it.
func TestCleanupKeepsTheJournalUntilTheBulkIsGone(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original", "conf/keep.txt": "original-config"},
		map[string]string{"db.bin": "restored"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	workDir, _, originalDir, planPath := paths(request)

	real := removeAll
	defer func() { removeAll = real }()
	var removed []string
	removeAll = func(path string) error {
		removed = append(removed, path)
		// The process dies before the last removal: the journal's own directory.
		if path == workDir {
			return errors.New("simulated crash")
		}
		return real(path)
	}
	if _, err := swapCleanup(request); err == nil {
		t.Fatal("cleanup survived a failed removal of the work directory")
	}
	if len(removed) != 3 || removed[2] != workDir {
		t.Fatalf("removal order = %v, want the originals and the incoming copy before the work directory", removed)
	}
	if _, err := os.Stat(originalDir); !os.IsNotExist(err) {
		t.Fatalf("the originals are still on disk: %v", err)
	}
	if _, err := os.Stat(planPath); err != nil {
		t.Fatalf("the journal went before the work was done: %v", err)
	}
	// Whoever resumes asks for the status first, and a committed swap whose
	// originals are partly gone is still `swapped`, not `inconsistent`.
	if report, err := swapStatus(request); err != nil || report.Status != statusSwapped {
		t.Fatalf("status after the interrupted clean-up = %+v, %v; want swapped", report, err)
	}

	// Repeated, it finishes instead of parking.
	removeAll = real
	if report, err := swapCleanup(request); err != nil || report.Status != statusCleaned {
		t.Fatalf("repeated cleanup = %+v, %v", report, err)
	}
	if _, err := os.Stat(workDir); !os.IsNotExist(err) {
		t.Fatalf("work directory survived the repeated cleanup: %v", err)
	}
}

// Before the commit is recorded, a missing original is still a foreign change.
func TestStatusStaysInconsistentForAMissingOriginalBeforeTheCommit(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original", "conf/keep.txt": "original-config"},
		map[string]string{"db.bin": "restored"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(request.Root, "conf")); err != nil {
		t.Fatal(err)
	}
	if report, err := swapStatus(request); err != nil || report.Status != statusInconsistent {
		t.Fatalf("status = %+v, %v; want inconsistent", report, err)
	}
}

// The mtime is cosmetic and is set after the journal is gone, so failing to set
// it must not turn a committed, cleaned volume into a failure that cannot be
// retried.
func TestCleanupSucceedsWhenTheRootMtimeCannotBeSet(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original"},
		map[string]string{"db.bin": "restored"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	real := setTimes
	defer func() { setTimes = real }()
	setTimes = func(string, time.Time, time.Time) error { return errors.New("simulated failure") }
	report, err := swapCleanup(request)
	if err != nil || report.Status != statusCleaned {
		t.Fatalf("cleanup = %+v, %v; want cleaned", report, err)
	}
	if _, err := os.Stat(filepath.Join(request.Root, workDirPrefix+testIntent)); !os.IsNotExist(err) {
		t.Fatalf("work directory survived: %v", err)
	}
	if got := readFile(t, filepath.Join(request.Root, "db.bin")); got != "restored" {
		t.Fatalf("db.bin = %q", got)
	}
}

// The mtime is cosmetic and is set after the journal is gone, so a rollback that
// cannot set it must still answer rolled back: failing it would leave a volume
// with its originals back, no journal, and no answer a retry could ever prove.
func TestRollbackSucceedsWhenTheRootMtimeCannotBeSet(t *testing.T) {
	request := setupVolume(t,
		map[string]string{"db.bin": "original"},
		map[string]string{"db.bin": "restored"},
	)
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	moveBudgetForTests = 1
	if _, err := swapCommit(request); err != nil {
		t.Fatalf("commit: %v", err)
	}
	moveBudgetForTests = -1
	real := setTimes
	defer func() { setTimes = real }()
	calls := 0
	setTimes = func(name string, _, _ time.Time) error {
		calls++
		if name != request.Root {
			t.Fatalf("setTimes(%q), want the volume root", name)
		}
		return errors.New("simulated failure")
	}
	report, err := swapRollback(request)
	if err != nil || report.Status != statusRolledBack {
		t.Fatalf("rollback = %+v, %v; want rolled_back", report, err)
	}
	if calls != 1 {
		t.Fatalf("setTimes called %d times, want once", calls)
	}
	if _, err := os.Stat(filepath.Join(request.Root, workDirPrefix+testIntent)); !os.IsNotExist(err) {
		t.Fatalf("work directory survived: %v", err)
	}
	if got := readFile(t, filepath.Join(request.Root, "db.bin")); got != "original" {
		t.Fatalf("db.bin = %q, want the original bytes", got)
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

// A commit that applied the incoming root's metadata and then failed before the
// journal recorded it (a chown that landed, a chmod that did not, a crash) is
// rolled back to a root that still carries the incoming owner, mode and mtime
// unless the rollback puts the original back. A plain rollback also moved the
// root's mtime with its renames, so both shapes are pinned.
func TestRollbackRestoresTheOriginalRootMetadata(t *testing.T) {
	for _, partial := range []bool{false, true} {
		name := "after renames only"
		if partial {
			name = "after the incoming root metadata was applied"
		}
		t.Run(name, func(t *testing.T) {
			request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
			original := time.Now().Add(-48 * time.Hour).Truncate(time.Second)
			if err := os.Chmod(request.Root, 0o711); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(request.Root, original, original); err != nil {
				t.Fatal(err)
			}
			if _, err := swapPrepare(request); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			writeCommitMarkerForTests = false
			_, err := swapCommit(request)
			writeCommitMarkerForTests = true
			if err != nil {
				t.Fatalf("commit: %v", err)
			}
			if partial {
				plan, err := readPlan(filepath.Join(request.Root, workDirPrefix+testIntent, planFileName))
				if err != nil {
					t.Fatal(err)
				}
				if err := applyRootMeta(request.Root, plan.Root); err != nil {
					t.Fatalf("apply: %v", err)
				}
				var applied syscall.Stat_t
				if err := syscall.Stat(request.Root, &applied); err != nil {
					t.Fatal(err)
				}
				if applied.Mode&0o7777 != 0o750 {
					t.Fatalf("the incoming mode was not applied: %o", applied.Mode&0o7777)
				}
			}
			if _, err := swapRollback(request); err != nil {
				t.Fatalf("rollback: %v", err)
			}
			var st syscall.Stat_t
			if err := syscall.Stat(request.Root, &st); err != nil {
				t.Fatal(err)
			}
			if got := st.Mode & 0o7777; got != 0o711 {
				t.Fatalf("root mode after rollback = %o, want 711", got)
			}
			if got := time.Unix(st.Mtim.Sec, st.Mtim.Nsec).Truncate(time.Second); !got.Equal(original) {
				t.Fatalf("root mtime after rollback = %s, want %s", got, original)
			}
		})
	}
}

// Go's os.Chmod drops setuid, setgid and sticky unless they are passed as flags,
// so a volume root with one of those bits must come out of a rollback, and out
// of a commit, with it intact.
func TestRootSpecialModeBitsSurviveRollbackAndCommit(t *testing.T) {
	const want = syscall.S_ISGID | 0o775
	for _, commit := range []bool{false, true} {
		name := "rollback"
		if commit {
			name = "commit"
		}
		t.Run(name, func(t *testing.T) {
			request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
			snapshot := filepath.Join(request.Root, workDirPrefix+testIntent, incomingDirName, snapshotRootName)
			if err := syscall.Chmod(request.Root, want); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Chmod(snapshot, want); err != nil {
				t.Fatal(err)
			}
			if _, err := swapPrepare(request); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			if commit {
				if _, err := swapCommit(request); err != nil {
					t.Fatalf("commit: %v", err)
				}
			} else if _, err := swapRollback(request); err != nil {
				t.Fatalf("rollback: %v", err)
			}
			var st syscall.Stat_t
			if err := syscall.Stat(request.Root, &st); err != nil {
				t.Fatal(err)
			}
			if got := st.Mode & 0o7777; got != want {
				t.Fatalf("root mode = %o, want %o", got, want)
			}
		})
	}
}

// A journal an older helper wrote has no original root, and a rollback leaves
// the root alone rather than reading zeros as an owner and mode.
func TestRollbackWithoutAnOriginalRootLeavesTheRootAlone(t *testing.T) {
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if err := os.Chmod(request.Root, 0o711); err != nil {
		t.Fatal(err)
	}
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	planPath := filepath.Join(request.Root, workDirPrefix+testIntent, planFileName)
	plan, err := readPlan(planPath)
	if err != nil {
		t.Fatal(err)
	}
	plan.OriginalRoot = nil
	if err := writePlan(planPath, plan); err != nil {
		t.Fatal(err)
	}
	if _, err := swapRollback(request); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	var st syscall.Stat_t
	if err := syscall.Stat(request.Root, &st); err != nil {
		t.Fatal(err)
	}
	if got := st.Mode & 0o7777; got != 0o711 {
		t.Fatalf("root mode = %o, want 711", got)
	}
}

// A journal write that cannot complete must not replace the journal: the
// original stays exactly as it was. /dev/full is the one way to make the write
// itself fail without a seam in the helper.
func TestAFailedJournalWriteLeavesTheJournalAlone(t *testing.T) {
	if _, err := os.Stat("/dev/full"); err != nil {
		t.Skip("/dev/full is not available")
	}
	request := setupVolume(t, map[string]string{"db.bin": "original"}, map[string]string{"new.txt": "restored"})
	if _, err := swapPrepare(request); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	planPath := filepath.Join(request.Root, workDirPrefix+testIntent, planFileName)
	before, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/full", planPath+".tmp"); err != nil {
		t.Fatal(err)
	}
	plan, err := readPlan(planPath)
	if err != nil {
		t.Fatal(err)
	}
	plan.Status = statusSwapped
	if err := writePlan(planPath, plan); err == nil {
		t.Fatal("writePlan reported success after a write that could not complete")
	}
	info, err := os.Lstat(planPath)
	if err != nil {
		t.Fatal(err)
	}
	// A journal that was renamed into place is the /dev/full symlink, not a
	// regular file, and reading it would never end.
	if !info.Mode().IsRegular() {
		t.Fatal("writePlan replaced the journal after a failed write")
	}
	after, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("writePlan replaced the journal after a failed write")
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
