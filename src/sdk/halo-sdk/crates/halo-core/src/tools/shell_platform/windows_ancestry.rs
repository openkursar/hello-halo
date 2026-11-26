use std::collections::{HashMap, HashSet, VecDeque};

pub(super) type Pid = u32;

#[derive(Clone, Copy)]
pub(super) struct Lifetime {
    pub created: u64,
    pub exited: Option<u64>,
}

#[derive(Clone, Copy)]
pub(super) struct Edge {
    pub parent: Pid,
    pub child: Pid,
    pub before: u64,
    pub native: bool,
}

pub(super) enum Proof {
    Child,
    ReusedParent,
    Unknown,
}

impl Edge {
    pub(super) fn prove(self, parent: Lifetime, child: Lifetime) -> Proof {
        if parent.created == 0 || child.created == 0 || child.created >= self.before {
            return Proof::Unknown;
        }
        if child.created < parent.created || parent.exited.is_some_and(|exit| child.created > exit)
        {
            return if self.native {
                Proof::ReusedParent
            } else {
                Proof::Unknown
            };
        }
        if child.created == parent.created || parent.exited == Some(child.created) {
            return Proof::Unknown;
        }
        Proof::Child
    }
}

pub(super) fn walk<T>(
    members: &mut HashMap<Pid, (T, Lifetime)>,
    edges: impl IntoIterator<Item = Edge>,
    host: Pid,
    mut open: impl FnMut(Pid) -> Option<(T, Lifetime)>,
) -> bool {
    let mut children: HashMap<Pid, Vec<Edge>> = HashMap::new();
    for edge in edges {
        children.entry(edge.parent).or_default().push(edge);
    }
    let mut unresolved = HashSet::new();
    let mut opened = HashMap::new();
    let mut queue: VecDeque<_> = members.keys().copied().collect();
    while let Some(pid) = queue.pop_front() {
        let Some(edges) = children.remove(&pid) else {
            continue;
        };
        let parent = members[&pid].1;
        for edge in edges {
            let child = edge.child;
            if child == pid || members.contains_key(&child) {
                continue;
            }
            if child == 0 || child == host {
                unresolved.insert(child);
                continue;
            }
            let Some((_, lifetime)) = opened.entry(child).or_insert_with(|| open(child)) else {
                unresolved.insert(child);
                continue;
            };
            match edge.prove(parent, *lifetime) {
                Proof::Child => {
                    let Some(Some(member)) = opened.remove(&child) else {
                        unreachable!()
                    };
                    members.insert(child, member);
                    unresolved.remove(&child);
                    queue.push_back(child);
                }
                Proof::ReusedParent => {}
                Proof::Unknown => {
                    unresolved.insert(child);
                }
            }
        }
    }
    unresolved.is_empty()
}

pub(super) fn has_trusted_msys_root<I: Iterator>(
    directly_verified: bool,
    verified_children: impl FnOnce() -> I,
) -> bool {
    if directly_verified {
        return true;
    }
    let mut children = verified_children();
    children.next().is_some() && children.next().is_none()
}

pub(super) fn confirmation_after_stop(
    complete: bool,
    first_scan: bool,
    stopped_by_request: Option<bool>,
) -> Option<bool> {
    stopped_by_request.map(|requested| complete && (!first_scan || requested))
}

pub(super) struct MsysTable {
    before: u64,
    rows: HashMap<Pid, MsysRow>,
}

struct MsysRow {
    parent: Pid,
    native: Pid,
}

impl MsysTable {
    pub(super) fn parse(text: &str, before: u64) -> Option<Self> {
        let mut lines = text.lines();
        if !lines
            .next()?
            .split_ascii_whitespace()
            .take(4)
            .eq(["PID", "PPID", "PGID", "WINPID"])
        {
            return None;
        }
        let mut rows = HashMap::new();
        let mut native_ids = HashSet::new();
        for line in lines.filter(|line| !line.trim().is_empty()) {
            let mut cells = line.split_ascii_whitespace();
            let first = cells.next()?;
            let pid = if first.len() == 1 && first.as_bytes()[0].is_ascii_alphabetic() {
                cells.next()?
            } else {
                first
            }
            .parse()
            .ok()?;
            let parent = cells.next()?.parse().ok()?;
            let _: Pid = cells.next()?.parse().ok()?;
            let native = cells.next()?.parse().ok()?;
            if (native != 0 && !native_ids.insert(native))
                || rows.insert(pid, MsysRow { parent, native }).is_some()
            {
                return None;
            }
        }
        Some(Self { before, rows })
    }

    pub(super) fn edges(&self) -> impl Iterator<Item = Edge> + '_ {
        self.rows.values().filter_map(|row| {
            Some(Edge {
                parent: self.rows.get(&row.parent)?.native,
                child: row.native,
                before: self.before,
                native: false,
            })
        })
    }

    pub(super) fn knows_root(&self, pid: Pid, created: u64) -> bool {
        created != 0
            && created < self.before
            && self.rows.values().filter(|row| row.native == pid).count() == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn member(created: u64) -> ((), Lifetime) {
        (
            (),
            Lifetime {
                created,
                exited: None,
            },
        )
    }
    fn edge(parent: Pid, child: Pid, before: u64) -> Edge {
        Edge {
            parent,
            child,
            before,
            native: true,
        }
    }

    #[test]
    fn trusted_msys_root_prefers_direct_proof_then_requires_one_verified_child() {
        let cases: &[(_, _, &[bool], _, _)] = &[
            ("direct root skips child scan", true, &[true, true], true, 0),
            ("no child matches", false, &[false, false], false, 2),
            ("no child candidates", false, &[], false, 0),
            ("one verified child", false, &[false, true, false], true, 3),
            (
                "two matches stop the scan",
                false,
                &[true, false, true, true],
                false,
                3,
            ),
        ];
        for &(name, direct, candidates, expected, inspected) in cases {
            let inspections = std::cell::Cell::new(0);
            let trusted = has_trusted_msys_root(direct, || {
                assert!(!direct, "{name}");
                candidates.iter().filter(|&&verified| {
                    inspections.set(inspections.get() + 1);
                    verified
                })
            });
            assert_eq!(trusted, expected, "{name}");
            assert_eq!(inspections.get(), inspected, "{name}");
        }
    }

    #[test]
    fn incomplete_stop_aborts_scans_without_erasing_earlier_doubt() {
        for (name, complete, first_scan, stopped_by_request, expected) in [
            ("first stop exceeded deadline", true, true, None, None),
            ("follow-up stop exceeded deadline", true, false, None, None),
            (
                "incomplete stop with earlier doubt",
                false,
                false,
                None,
                None,
            ),
            (
                "stop did not cause initial exit",
                true,
                true,
                Some(false),
                Some(false),
            ),
            (
                "initial stop and exit observed",
                true,
                true,
                Some(true),
                Some(true),
            ),
            (
                "already stopped on follow-up",
                true,
                false,
                Some(false),
                Some(true),
            ),
            (
                "confirmation cannot erase earlier doubt",
                false,
                true,
                Some(true),
                Some(false),
            ),
            (
                "follow-up cannot erase earlier doubt",
                false,
                false,
                Some(true),
                Some(false),
            ),
        ] {
            assert_eq!(
                confirmation_after_stop(complete, first_scan, stopped_by_request),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn native_edge_does_not_inherit_an_earlier_msys_cutoff() {
        let mut members = HashMap::from([(1, member(10))]);
        let stale_edge = Edge {
            native: false,
            ..edge(1, 2, 20)
        };
        assert!(walk(&mut members, [stale_edge, edge(1, 2, 30)], 99, |_| {
            Some(member(21))
        }));
        assert!(members.contains_key(&2));
    }

    #[test]
    fn follow_up_finds_children_born_before_the_held_parent_exit_but_not_pid_reuse() {
        let mut members = HashMap::from([(
            1,
            (
                (),
                Lifetime {
                    created: 10,
                    exited: Some(34),
                },
            ),
        )]);
        assert!(!walk(&mut members, [edge(1, 2, 30)], 99, |_| Some(member(
            32
        ))));
        assert!(!members.contains_key(&2));
        assert!(walk(
            &mut members,
            [edge(1, 2, 40), edge(1, 3, 40), edge(1, 4, 40)],
            99,
            |pid| {
                Some(member(match pid {
                    2 => 32,
                    3 => 38,
                    _ => 9,
                }))
            }
        ));
        assert!(members.contains_key(&2));
        assert!(!members.contains_key(&3));
        assert!(!members.contains_key(&4));
    }

    #[test]
    fn msys_transition_and_host_rows_are_not_traversed_or_reported_complete() {
        let table = MsysTable::parse("PID PPID PGID WINPID TTY UID STIME COMMAND\n11 1 11 101 ? 1 00:00 bash\n12 11 11 0 ? 1 00:00 transient\nS 13 12 11 102 ? 1 00:00 sleep\n14 11 11 200 ? 1 00:00 host\n15 14 11 201 ? 1 00:00 other\n", 50).unwrap();
        let mut members = HashMap::from([(101, member(10))]);
        assert!(table.knows_root(101, 10));
        assert!(!walk(&mut members, table.edges(), 200, |_| panic!(
            "unverified node was opened"
        )));
        assert_eq!(members.len(), 1);
        assert!(MsysTable::parse("PID PPID PGID WINPID\ninvalid row", 50).is_none());
    }

    #[test]
    fn windows_process_ancestry_matches_observed_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/shell-platform.json")).unwrap();
        for case in fixture["ancestry"].as_array().unwrap() {
            let pid = |value: &Value| value.as_u64().unwrap() as Pid;
            let root = pid(&case["root"]);
            let host = pid(&case["self"]);
            let posix = MsysTable::parse(case["posix"].as_str().unwrap(), u64::MAX);
            let expected = case["expected"].as_array().unwrap();
            let times: HashMap<_, _> = expected
                .iter()
                .enumerate()
                .map(|(index, value)| (pid(value), index as u64 + 1))
                .collect();
            let native = case["native"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| edge(pid(&row["parent"]), pid(&row["pid"]), u64::MAX));
            let mut members = HashMap::from([(root, member(times[&root]))]);
            assert!(walk(
                &mut members,
                native.chain(posix.iter().flat_map(MsysTable::edges)),
                host,
                |pid| times.get(&pid).map(|time| member(*time))
            ));
            assert_eq!(
                members.keys().copied().collect::<HashSet<_>>(),
                times.keys().copied().collect()
            );
        }
    }
}
