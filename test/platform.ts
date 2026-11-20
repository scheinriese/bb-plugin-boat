// Tests that run Boat's real sandbox scripts here (on a copy, with a fake systemctl, ps or npm)
// need the Linux tools those scripts are written for: GNU coreutils (timeout, setsid, sha256sum,
// sed -i, xargs -d), GNU find, procfs and systemd. CI runs on Linux; elsewhere (macOS) they skip.
export const LINUX_ONLY = { skip: process.platform !== "linux" && "runs the real sandbox scripts, which need Linux tools (GNU coreutils, procfs, systemctl)" };
