package main

import "syscall"

// lstat is a seam over syscall.Lstat, so a guard test can describe a root
// without owning a real directory of every shape.
var lstat = func(path string, st *syscall.Stat_t) error {
	return syscall.Lstat(path, st)
}
