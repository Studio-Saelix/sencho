package main

// The swap subcommand turns a staged restore into the live one, inside the
// target volume, with a journal that makes every intermediate state resumable.
//
// Docker cannot rename a volume or exchange two volumes, so there is no atomic
// replacement of a named volume. What this does instead is a *journaled rename
// swap*: every original top-level entry is moved into the work directory, then
// every restored entry is moved up, and only then is the root's own owner and
// mode applied. Each rename is atomic; the set of them is not. The plan file is
// the journal, and the state is a deterministic function of the directory
// contents plus that plan, so a crash at any point can be resumed in either
// direction.
//
//	swap prepare  --root <volume> --id <intent>
//	swap commit   --root <volume> --id <intent>
//	swap status   --root <volume> --id <intent>
//	swap rollback --root <volume> --id <intent>
//	swap cleanup  --root <volume> --id <intent>
//
// Output: one JSON object on stdout. Exit 0 on success, 1 on a refusal or an
// inconsistent state.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	swapPlanVersion = 1
	workDirPrefix   = ".sencho-restore-"
	planFileName    = "plan.json"
	incomingDirName = "incoming"
	originalDirName = "original"
	// The restored snapshot root. A whole-snapshot restore of a capture of
	// `/data` lands as `<incoming>/data`, so the snapshot root's own owner and
	// mode arrive as an ordinary directory entry the swap can apply.
	snapshotRootName = "data"

	statusPlanned         = "planned"
	statusMovingOriginals = "moving_originals"
	statusMovingIncoming  = "moving_incoming"
	statusSwapped         = "swapped"
	// Every entry has moved but the commit marker is not in the journal yet, so
	// the root metadata has not been applied and the originals are still inside
	// the volume. Cleanup must not run, and the caller repeats commit instead.
	statusMetadataPending = "metadata_pending"
	statusRolledBack      = "rolled_back"
	statusCleaned         = "cleaned"
	statusInconsistent    = "inconsistent"
)

// moveBudgetForTests interrupts a commit after this many renames, so the tests
// can resume from every possible point. A negative value means no limit.
var moveBudgetForTests = -1

// writeCommitMarkerForTests lets a test stop after the last rename but before
// the root metadata and the journal marker, which is the crash window the
// cleanup guard exists for.
var writeCommitMarkerForTests = true

var intentIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type rootMeta struct {
	UID   uint32 `json:"uid"`
	GID   uint32 `json:"gid"`
	Mode  uint32 `json:"mode"`
	Mtime int64  `json:"mtime"` // Unix nanoseconds
}

type swapPlan struct {
	Version   int      `json:"version"`
	ID        string   `json:"id"`
	Status    string   `json:"status"`
	Originals []string `json:"originals"`
	Incoming  []string `json:"incoming"`
	Root      rootMeta `json:"root"`
	// The volume root's own owner, mode and mtime as `prepare` found them (the
	// work directory already exists then, so the mtime is the one after it was
	// created). A commit that applied part of `Root` and then failed is rolled
	// back to these. Absent in a journal an older helper wrote, which a rollback
	// leaves alone.
	OriginalRoot *rootMeta `json:"original_root,omitempty"`
	RootDev      int64     `json:"root_dev"`
	RootIno      uint64    `json:"root_ino"`
}

type swapReport struct {
	Status    string   `json:"status"`
	Originals []string `json:"originals,omitempty"`
	Incoming  []string `json:"incoming,omitempty"`
	Moved     int      `json:"moved"`
}

type swapRequest struct {
	Root string
	ID   string
}

func runSwap(args []string) {
	if len(args) == 0 {
		fail("usage: sencho-recovery-probe swap <prepare|commit|status|rollback|cleanup> --root <path> --id <intent>")
	}
	action := args[0]
	flags := flag.NewFlagSet("swap "+action, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "the mounted volume root")
	id := flags.String("id", "", "the restore intent id")
	if err := flags.Parse(args[1:]); err != nil {
		fail(err.Error())
	}
	if *root == "" || *id == "" {
		fail("usage: sencho-recovery-probe swap <prepare|commit|status|rollback|cleanup> --root <path> --id <intent>")
	}
	if !intentIDPattern.MatchString(*id) {
		fail("invalid intent id")
	}
	request := swapRequest{Root: *root, ID: *id}
	var (
		report swapReport
		err    error
	)
	switch action {
	case "prepare":
		report, err = swapPrepare(request)
	case "commit":
		report, err = swapCommit(request)
	case "status":
		report, err = swapStatus(request)
	case "rollback":
		report, err = swapRollback(request)
	case "cleanup":
		report, err = swapCleanup(request)
	default:
		fail("unknown swap action: " + action)
	}
	if err != nil {
		fail(err.Error())
	}
	out, marshalErr := json.Marshal(report)
	if marshalErr != nil {
		fail(marshalErr.Error())
	}
	fmt.Println(string(out))
}

func paths(request swapRequest) (workDir, incomingRoot, originalDir, planPath string) {
	workDir = filepath.Join(request.Root, workDirPrefix+request.ID)
	incomingRoot = filepath.Join(workDir, incomingDirName, snapshotRootName)
	originalDir = filepath.Join(workDir, originalDirName)
	planPath = filepath.Join(workDir, planFileName)
	return
}

// removeAll is a seam: a test replaces it to stop a removal part way, which is
// what a crash during clean-up looks like.
var removeAll = os.RemoveAll

// setTimes is a seam for the same reason, for the last step of a clean-up or a rollback.
var setTimes = os.Chtimes

// removeWorkDir deletes a committed swap's work directory with the journal last.
// The journal lives inside the directory and RemoveAll deletes in directory
// order, so one RemoveAll could take plan.json first and then die with the
// originals still on disk, leaving a work directory no journal explains. Deleting
// the bulk first keeps the journal until nothing it describes is left, so an
// interrupted clean-up is repeated rather than parked (`computeStatus` keeps
// answering `swapped` while the journal says so). Rollback does not use it: a
// rollback decides what to move from the restored copy, so that copy has to
// outlive the journal's last use.
func removeWorkDir(workDir string) error {
	for _, dir := range []string{
		filepath.Join(workDir, originalDirName),
		filepath.Join(workDir, incomingDirName),
	} {
		if err := removeAll(dir); err != nil {
			return err
		}
	}
	return removeAll(workDir)
}

func listNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names, nil
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func statRoot(path string) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	err := syscall.Lstat(path, &st)
	return st, err
}

/**
 * `prepare` records the plan and nothing else. It refuses a second work
 * directory, because two swaps in one volume have no defined order.
 */
func swapPrepare(request swapRequest) (swapReport, error) {
	_, incomingRoot, originalDir, planPath := paths(request)
	if !exists(incomingRoot) {
		return swapReport{}, errors.New("no restored snapshot at " + filepath.Join(incomingDirName, snapshotRootName))
	}

	entries, err := listNames(request.Root)
	if err != nil {
		return swapReport{}, err
	}
	for _, name := range entries {
		if strings.HasPrefix(name, workDirPrefix) && name != workDirPrefix+request.ID {
			return swapReport{}, errors.New("another restore work directory exists in this volume")
		}
	}

	// A plan already written belongs to a resumed run: answer with what the
	// journal says instead of rewriting a progressed plan.
	if exists(planPath) {
		plan, readErr := readPlan(planPath)
		if readErr != nil {
			return swapReport{}, readErr
		}
		if plan.ID != request.ID {
			return swapReport{}, errors.New("the journal belongs to another restore")
		}
		status, statusErr := computeStatus(request, plan)
		if statusErr != nil {
			return swapReport{}, statusErr
		}
		return swapReport{Status: status, Originals: plan.Originals, Incoming: plan.Incoming}, nil
	}
	if exists(originalDir) {
		return swapReport{}, errors.New("a work directory exists without a journal")
	}

	originals := make([]string, 0, len(entries))
	for _, name := range entries {
		if name == workDirPrefix+request.ID {
			continue
		}
		originals = append(originals, name)
	}
	incoming, err := listNames(incomingRoot)
	if err != nil {
		return swapReport{}, err
	}

	st, err := statRoot(incomingRoot)
	if err != nil {
		return swapReport{}, err
	}
	rootStat, err := statRoot(request.Root)
	if err != nil {
		return swapReport{}, err
	}
	plan := swapPlan{
		Version:   swapPlanVersion,
		ID:        request.ID,
		Status:    statusPlanned,
		Originals: originals,
		Incoming:  incoming,
		Root: rootMeta{
			UID:   st.Uid,
			GID:   st.Gid,
			Mode:  uint32(st.Mode) & 0o7777,
			Mtime: time.Unix(st.Mtim.Sec, st.Mtim.Nsec).UnixNano(),
		},
		OriginalRoot: &rootMeta{
			UID:   rootStat.Uid,
			GID:   rootStat.Gid,
			Mode:  uint32(rootStat.Mode) & 0o7777,
			Mtime: time.Unix(rootStat.Mtim.Sec, rootStat.Mtim.Nsec).UnixNano(),
		},
		RootDev: int64(rootStat.Dev),
		RootIno: rootStat.Ino,
	}
	if err := writePlan(planPath, plan); err != nil {
		return swapReport{}, err
	}
	return swapReport{Status: statusPlanned, Originals: plan.Originals, Incoming: plan.Incoming}, nil
}

func readPlan(path string) (swapPlan, error) {
	var plan swapPlan
	data, err := os.ReadFile(path)
	if err != nil {
		return plan, err
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		return plan, fmt.Errorf("unreadable journal: %w", err)
	}
	if plan.Version != swapPlanVersion {
		return plan, errors.New("unknown journal version")
	}
	return plan, nil
}

func writePlan(path string, plan swapPlan) error {
	data, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		if cerr := file.Close(); cerr != nil {
			return errors.Join(err, cerr)
		}
		return err
	}
	if err := file.Sync(); err != nil {
		if cerr := file.Close(); cerr != nil {
			return errors.Join(err, cerr)
		}
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

/**
 * `computeStatus` reads the state from the directories, never from a progress
 * counter in the journal. A name that is nowhere, or a root entry the plan does
 * not name, means something else wrote to the volume: the only safe answer is
 * `inconsistent`, which the caller reports and never resumes from.
 */
func computeStatus(request swapRequest, plan swapPlan) (string, error) {
	// The journal is the commit point: once commit has applied the root metadata
	// and written `swapped`, the swap is complete. From then on the workloads may
	// run, so a new root entry, or an entry of the restored set they renamed or
	// removed, is their progress and not evidence against the commit; reading it as
	// `inconsistent` would leave the originals in the volume with no way to remove
	// them. The originals waiting for (or half through) their clean-up are progress too.
	if plan.Status == statusSwapped {
		return statusSwapped, nil
	}
	_, incomingRoot, originalDir, _ := paths(request)
	originalsMoved := 0
	for _, name := range plan.Originals {
		switch {
		case exists(filepath.Join(originalDir, name)):
			originalsMoved++
		case exists(filepath.Join(request.Root, name)):
			// Not moved yet.
		default:
			return statusInconsistent, nil
		}
	}
	incomingMoved := 0
	for _, name := range plan.Incoming {
		atIncoming := exists(filepath.Join(incomingRoot, name))
		atRoot := exists(filepath.Join(request.Root, name))
		switch {
		case atIncoming && atRoot && !contains(plan.Originals, name):
			// The root already holds an entry the plan does not explain.
			return statusInconsistent, nil
		case atIncoming:
			// Not moved yet.
		case atRoot:
			incomingMoved++
		default:
			return statusInconsistent, nil
		}
	}

	known := map[string]bool{workDirPrefix + request.ID: true}
	for _, name := range plan.Originals {
		known[name] = true
	}
	for _, name := range plan.Incoming {
		known[name] = true
	}
	rootEntries, err := listNames(request.Root)
	if err != nil {
		return "", err
	}
	for _, name := range rootEntries {
		if !known[name] {
			return statusInconsistent, nil
		}
	}

	switch {
	case originalsMoved == 0 && incomingMoved == 0:
		return statusPlanned, nil
	case originalsMoved < len(plan.Originals):
		return statusMovingOriginals, nil
	case incomingMoved < len(plan.Incoming):
		return statusMovingIncoming, nil
	default:
		// Every entry moved, but the journal is the commit point: the root
		// metadata has not been applied and the originals are still here, so this
		// is not a committed swap. `commit` finishes it; nothing may clean up.
		return statusMetadataPending, nil
	}
}

func contains(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}

func consumeMove() bool {
	if moveBudgetForTests < 0 {
		return true
	}
	if moveBudgetForTests == 0 {
		return false
	}
	moveBudgetForTests--
	return true
}

/** `commit` moves originals away, then incoming up, then applies root metadata. */
func swapCommit(request swapRequest) (swapReport, error) {
	workDir, incomingRoot, originalDir, planPath := paths(request)
	if !exists(planPath) {
		return swapReport{}, errors.New("no journal: run prepare first")
	}
	plan, err := readPlan(planPath)
	if err != nil {
		return swapReport{}, err
	}
	if plan.ID != request.ID {
		return swapReport{}, errors.New("the journal belongs to another restore")
	}
	rootStat, err := statRoot(request.Root)
	if err != nil {
		return swapReport{}, err
	}
	if int64(rootStat.Dev) != plan.RootDev || rootStat.Ino != plan.RootIno {
		return swapReport{}, errors.New(statusInconsistent)
	}
	status, err := computeStatus(request, plan)
	if err != nil {
		return swapReport{}, err
	}
	if status == statusInconsistent {
		return swapReport{}, errors.New(statusInconsistent)
	}
	// The journal is the commit point. A `metadata_pending` state means the moves
	// finished before a crash but the root metadata was not applied; the rest of
	// this function applies it and commits.
	if plan.Status == statusSwapped {
		return swapReport{Status: statusSwapped, Originals: plan.Originals, Incoming: plan.Incoming}, nil
	}

	moved := 0
	// Created even when the volume held no entries: the commit syncs it, and an
	// empty volume is a legitimate target.
	if !exists(originalDir) {
		if err := os.MkdirAll(originalDir, 0o700); err != nil {
			return swapReport{}, err
		}
	}
	if plan.Status == statusPlanned {
		plan.Status = statusMovingOriginals
		if err := writePlan(planPath, plan); err != nil {
			return swapReport{}, err
		}
	}

	for _, name := range plan.Originals {
		if exists(filepath.Join(originalDir, name)) {
			continue
		}
		if !exists(filepath.Join(request.Root, name)) {
			return swapReport{}, errors.New(statusInconsistent)
		}
		if !consumeMove() {
			return swapReport{Status: statusMovingOriginals, Originals: plan.Originals, Incoming: plan.Incoming, Moved: moved}, nil
		}
		if err := os.Rename(filepath.Join(request.Root, name), filepath.Join(originalDir, name)); err != nil {
			return swapReport{}, err
		}
		moved++
	}
	if exists(originalDir) {
		if err := syncDir(originalDir); err != nil {
			return swapReport{}, err
		}
	}
	if err := syncDir(request.Root); err != nil {
		return swapReport{}, err
	}
	if plan.Status != statusMovingIncoming {
		plan.Status = statusMovingIncoming
		if err := writePlan(planPath, plan); err != nil {
			return swapReport{}, err
		}
	}

	for _, name := range plan.Incoming {
		if !exists(filepath.Join(incomingRoot, name)) {
			// An entry that already reached the root is done; one that never did
			// is caught by computeStatus above.
			continue
		}
		if !consumeMove() {
			return swapReport{Status: statusMovingIncoming, Originals: plan.Originals, Incoming: plan.Incoming, Moved: moved}, nil
		}
		if err := os.Rename(filepath.Join(incomingRoot, name), filepath.Join(request.Root, name)); err != nil {
			return swapReport{}, err
		}
		moved++
	}
	if !writeCommitMarkerForTests {
		return swapReport{Status: statusMetadataPending, Originals: plan.Originals, Incoming: plan.Incoming, Moved: moved}, nil
	}
	if err := applyRootMeta(request.Root, plan.Root); err != nil {
		return swapReport{}, err
	}
	if err := syncDir(request.Root); err != nil {
		return swapReport{}, err
	}
	if err := syncDir(incomingRoot); err != nil {
		return swapReport{}, err
	}
	plan.Status = statusSwapped
	if err := writePlan(planPath, plan); err != nil {
		return swapReport{}, err
	}
	if err := syncDir(workDir); err != nil {
		return swapReport{}, err
	}
	return swapReport{Status: statusSwapped, Originals: plan.Originals, Incoming: plan.Incoming, Moved: moved}, nil
}

func applyRootMeta(root string, meta rootMeta) error {
	if err := os.Chown(root, int(meta.UID), int(meta.GID)); err != nil {
		return err
	}
	// syscall.Chmod takes the raw mode. os.Chmod would drop setuid, setgid and
	// sticky, which Go carries as separate flags and the recorded mode holds as
	// the 0o7000 bits.
	if err := syscall.Chmod(root, meta.Mode); err != nil {
		return err
	}
	mtime := time.Unix(0, meta.Mtime)
	return os.Chtimes(root, mtime, mtime)
}

/** `status` answers the computed state without changing anything. */
func swapStatus(request swapRequest) (swapReport, error) {
	_, _, _, planPath := paths(request)
	if !exists(planPath) {
		if exists(filepath.Join(request.Root, workDirPrefix+request.ID)) {
			return swapReport{Status: statusInconsistent}, nil
		}
		return swapReport{Status: "absent"}, nil
	}
	plan, err := readPlan(planPath)
	if err != nil {
		return swapReport{}, err
	}
	status, err := computeStatus(request, plan)
	if err != nil {
		return swapReport{}, err
	}
	return swapReport{Status: status, Originals: plan.Originals, Incoming: plan.Incoming}, nil
}

/**
 * `rollback` is only allowed before the journal says the swap committed. It
 * moves the restored entries back into the work directory first, so an overlap
 * between an original and a restored name resolves in the original's favour.
 */
func swapRollback(request swapRequest) (swapReport, error) {
	workDir, incomingRoot, originalDir, planPath := paths(request)
	if !exists(planPath) {
		if exists(workDir) {
			if err := os.RemoveAll(workDir); err != nil {
				return swapReport{}, err
			}
			if err := syncDir(request.Root); err != nil {
				return swapReport{}, err
			}
		}
		return swapReport{Status: statusRolledBack}, nil
	}
	plan, err := readPlan(planPath)
	if err != nil {
		return swapReport{}, err
	}
	status, err := computeStatus(request, plan)
	if err != nil {
		return swapReport{}, err
	}
	if status == statusSwapped {
		return swapReport{}, errors.New("the swap is committed and cannot be rolled back")
	}
	if status == statusInconsistent {
		return swapReport{}, errors.New(statusInconsistent)
	}

	for _, name := range plan.Incoming {
		atRoot := filepath.Join(request.Root, name)
		atIncoming := filepath.Join(incomingRoot, name)
		if exists(atRoot) && !exists(atIncoming) {
			if !consumeMove() {
				return swapReport{Status: plan.Status}, nil
			}
			if err := os.MkdirAll(incomingRoot, 0o700); err != nil {
				return swapReport{}, err
			}
			if err := os.Rename(atRoot, atIncoming); err != nil {
				return swapReport{}, err
			}
		}
	}
	for _, name := range plan.Originals {
		atOriginal := filepath.Join(originalDir, name)
		if !exists(atOriginal) {
			continue
		}
		if !consumeMove() {
			return swapReport{Status: plan.Status}, nil
		}
		if err := os.Rename(atOriginal, filepath.Join(request.Root, name)); err != nil {
			return swapReport{}, err
		}
	}
	// The commit applies the incoming root's owner, mode and mtime last, so a
	// failure part way through it (a chown that landed, a chmod that did not)
	// leaves the root carrying them. Putting the original back is idempotent, and
	// owner and mode go before the work directory so a failure there can be
	// retried. The mtime is set after the removal, which moves it; a failure of
	// that last step cannot be retried, and only the mtime is lost.
	if plan.OriginalRoot != nil {
		if err := applyRootMeta(request.Root, *plan.OriginalRoot); err != nil {
			return swapReport{}, err
		}
	}
	if err := os.RemoveAll(workDir); err != nil {
		return swapReport{}, err
	}
	if err := syncDir(request.Root); err != nil {
		return swapReport{}, err
	}
	// The renames and the removal above moved the root's mtime, so it is set last.
	// The journal is gone by now, so a failure here cannot be retried, and it is
	// not worth failing a rolled back volume for: it is reported on stderr and only
	// the mtime is lost, as in `cleanup`. An error would leave the caller with no
	// journal and no answer.
	if plan.OriginalRoot != nil {
		mtime := time.Unix(0, plan.OriginalRoot.Mtime)
		if err := setTimes(request.Root, mtime, mtime); err != nil {
			fmt.Fprintf(os.Stderr, "warning: the root modification time was not restored: %v\n", err)
		}
	}
	return swapReport{Status: statusRolledBack, Originals: plan.Originals, Incoming: plan.Incoming}, nil
}

/**
 * `cleanup` removes the work directory once the journal proves the swap is
 * complete. It is the last step before any workload restarts, because some
 * engines treat an unknown directory in their data root as data (MySQL turns a
 * subdirectory of its datadir into a database).
 */
func swapCleanup(request swapRequest) (swapReport, error) {
	workDir, _, _, planPath := paths(request)
	if !exists(planPath) {
		if exists(workDir) {
			return swapReport{}, errors.New("a work directory exists without a journal")
		}
		return swapReport{Status: statusCleaned}, nil
	}
	plan, err := readPlan(planPath)
	if err != nil {
		return swapReport{}, err
	}
	// Only the journal's commit marker proves the root metadata was applied. A
	// computed `swapped` without it can still be rolled back, and deleting the
	// originals then would be the one unrecoverable mistake this design can make.
	if plan.Status != statusSwapped {
		return swapReport{}, errors.New("the swap is not complete")
	}
	if err := removeWorkDir(workDir); err != nil {
		return swapReport{}, err
	}
	if err := syncDir(request.Root); err != nil {
		return swapReport{}, err
	}
	// Removing the work directory changed the root's mtime, so the captured one
	// the commit applied is set again. Only a run that removed the directory
	// gets here: a repeated cleanup answers above and leaves a root the
	// application has since written to alone. The journal is gone by now, so a
	// failure of this last step cannot be retried, and it is not worth failing a
	// committed, cleaned volume for: it is reported on stderr and only the mtime
	// is lost.
	mtime := time.Unix(0, plan.Root.Mtime)
	if err := setTimes(request.Root, mtime, mtime); err != nil {
		fmt.Fprintf(os.Stderr, "warning: the root modification time was not restored: %v\n", err)
	}
	return swapReport{Status: statusCleaned, Originals: plan.Originals, Incoming: plan.Incoming}, nil
}
