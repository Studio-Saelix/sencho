//go:build linux && !amd64 && !arm64

package main

// No statx number is wired for this architecture, so no birth time is reported
// and Sencho falls back to the device and inode.
const sysStatx = -1
