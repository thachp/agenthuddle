#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::*;
use TaskStatus::*;

fn task(status: TaskStatus) -> Task {
    let assigned = !matches!(status, Open);
    Task {
        id: "t".into(),
        title: "title".into(),
        instructions: "instructions".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: assigned.then(|| "asg".to_string()),
        reviewer: "rev".into(),
        status,
        version: 5,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 2,
        submission_commit: None,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn commands() -> Vec<(&'static str, Command)> {
    vec![
        (
            "update",
            Command::Update {
                version: 5,
                patch: TaskPatch {
                    title: Some("new".into()),
                    ..Default::default()
                },
            },
        ),
        (
            "set_reviewer",
            Command::SetReviewer {
                version: 5,
                reviewer: "rev2".into(),
            },
        ),
        (
            "set_requester",
            Command::SetRequester {
                version: 5,
                requester: "req2".into(),
            },
        ),
        (
            "assign",
            Command::Assign {
                version: 5,
                assignee: "asg2".into(),
            },
        ),
        ("accept", Command::Accept { version: 5 }),
        (
            "decline",
            Command::Decline {
                version: 5,
                reason: "no".into(),
            },
        ),
        (
            "release",
            Command::Release {
                version: 5,
                reason: "no".into(),
            },
        ),
        (
            "submit",
            Command::Submit {
                version: 5,
                artifacts: vec![],
                note: Some("done".into()),
                commit_sha: None,
            },
        ),
        (
            "request_changes",
            Command::RequestChanges {
                submission_no: 2,
                reason: "fix".into(),
            },
        ),
        (
            "verify",
            Command::Verify {
                submission_no: 2,
                commit_sha: None,
            },
        ),
        (
            "cancel",
            Command::Cancel {
                version: 5,
                reason: "no".into(),
            },
        ),
    ]
}

/// The lifecycle table from PRODUCT.md. `None` means the command is an invalid transition from that status.
fn expected(command: &str, from: TaskStatus) -> Option<TaskStatus> {
    match (command, from) {
        ("update", Open | Offered | Accepted) => Some(from),
        ("set_reviewer" | "set_requester", Open | Offered | Accepted | Submitted) => Some(from),
        ("assign", Open | Offered) => Some(Offered),
        ("accept", Offered) => Some(Accepted),
        ("decline", Offered) => Some(Open),
        ("release", Accepted) => Some(Open),
        ("submit", Accepted) => Some(Submitted),
        ("request_changes", Submitted) => Some(Accepted),
        ("verify", Submitted) => Some(Completed),
        ("cancel", Open | Offered | Accepted | Submitted) => Some(Canceled),
        _ => None,
    }
}

#[test]
fn every_status_and_command_matches_the_lifecycle_table() {
    let mut checked = 0;
    for from in TaskStatus::ALL {
        for (name, command) in commands() {
            let result = decide(&task(from), "actor", command, &Observed::default());
            match expected(name, from) {
                Some(to) => {
                    let decision = result.unwrap_or_else(|e| panic!("{name} from {from:?}: {e:?}"));
                    assert_eq!(decision.task.status, to, "{name} from {from:?}");
                    assert_eq!(decision.task.version, 6, "{name} bumps the version");
                    assert!(!decision.events.is_empty(), "{name} records an event");
                }
                None => assert_eq!(
                    result.unwrap_err(),
                    CoreError::InvalidTransition,
                    "{name} from {from:?}"
                ),
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 66);
}

#[test]
fn stale_versions_never_apply() {
    for from in TaskStatus::ALL {
        for (name, command) in commands() {
            let stale = match command {
                Command::Update { patch, .. } => Command::Update { version: 4, patch },
                Command::SetReviewer { reviewer, .. } => Command::SetReviewer {
                    version: 4,
                    reviewer,
                },
                Command::SetRequester { requester, .. } => Command::SetRequester {
                    version: 4,
                    requester,
                },
                Command::Assign { assignee, .. } => Command::Assign {
                    version: 4,
                    assignee,
                },
                Command::Accept { .. } => Command::Accept { version: 4 },
                Command::Decline { reason, .. } => Command::Decline { version: 4, reason },
                Command::Release { reason, .. } => Command::Release { version: 4, reason },
                Command::Submit {
                    artifacts,
                    note,
                    commit_sha,
                    ..
                } => Command::Submit {
                    version: 4,
                    artifacts,
                    note,
                    commit_sha,
                },
                Command::Cancel { reason, .. } => Command::Cancel { version: 4, reason },
                Command::RequestChanges { .. } | Command::Verify { .. } => continue,
            };
            assert_eq!(
                decide(&task(from), "actor", stale, &Observed::default()).unwrap_err(),
                CoreError::VersionConflict,
                "{name}"
            );
        }
    }
}

#[test]
fn create_defaults_the_reviewer_and_offers_when_assigned() {
    let new = |assignee: Option<&str>, reviewer: Option<&str>| NewTask {
        id: "t".into(),
        title: "title".into(),
        instructions: "do it".into(),
        acceptance_criteria: None,
        assignee: assignee.map(Into::into),
        reviewer: reviewer.map(Into::into),
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
    };
    let open = decide_create("req", new(None, None)).unwrap();
    assert_eq!(
        (open.task.status, open.task.reviewer.as_str()),
        (Open, "req")
    );
    let offered = decide_create("req", new(Some("asg"), None)).unwrap();
    assert_eq!(offered.task.status, Offered);
    assert!(offered.events[0].recipients.contains("asg"));
    assert_eq!(
        decide_create("req", new(Some("req"), None)).unwrap_err(),
        CoreError::SelfSignOff
    );
    assert_eq!(
        decide_create("req", new(Some("asg"), Some("asg"))).unwrap_err(),
        CoreError::SelfSignOff
    );
    assert_eq!(
        decide_create(
            "req",
            NewTask {
                title: "  ".into(),
                ..new(None, None)
            }
        )
        .unwrap_err(),
        CoreError::InvalidArgument("title")
    );
}

#[test]
fn nobody_signs_off_their_own_work() {
    let submitted = task(Submitted);
    let cmd = || Command::Verify {
        submission_no: 2,
        commit_sha: None,
    };
    assert_eq!(
        decide(&submitted, "asg", cmd(), &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
    let set = Command::SetReviewer {
        version: 5,
        reviewer: "asg".into(),
    };
    assert_eq!(
        decide(&submitted, "req", set, &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
    let assign = Command::Assign {
        version: 5,
        assignee: "rev".into(),
    };
    assert_eq!(
        decide(&task(Open), "req", assign, &Observed::default()).unwrap_err(),
        CoreError::SelfSignOff
    );
}

#[test]
fn reviews_bind_to_one_submission() {
    let verify = Command::Verify {
        submission_no: 1,
        commit_sha: None,
    };
    assert_eq!(
        decide(&task(Submitted), "rev", verify, &Observed::default()).unwrap_err(),
        CoreError::SubmissionMismatch
    );
    let changes = Command::RequestChanges {
        submission_no: 3,
        reason: "x".into(),
    };
    assert_eq!(
        decide(&task(Submitted), "rev", changes, &Observed::default()).unwrap_err(),
        CoreError::SubmissionMismatch
    );
}

#[test]
fn material_edits_need_acceptance_again() {
    let accepted = task(Accepted);
    let edit = |patch| Command::Update { version: 5, patch };
    let title = edit(TaskPatch {
        title: Some("new".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", title, &Observed::default())
            .unwrap()
            .task
            .status,
        Accepted
    );
    let same = edit(TaskPatch {
        instructions: Some("instructions".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", same, &Observed::default())
            .unwrap()
            .task
            .status,
        Accepted
    );
    let body = edit(TaskPatch {
        instructions: Some("changed".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", body, &Observed::default())
            .unwrap()
            .task
            .status,
        Offered
    );
    let criteria = edit(TaskPatch {
        acceptance_criteria: Some("new".into()),
        ..Default::default()
    });
    assert_eq!(
        decide(&accepted, "req", criteria, &Observed::default())
            .unwrap()
            .task
            .status,
        Offered
    );
}

#[test]
fn submit_needs_content_and_respects_limits() {
    let accepted = task(Accepted);
    let submit = |artifacts: Vec<Artifact>, note: Option<&str>| Command::Submit {
        version: 5,
        artifacts,
        note: note.map(Into::into),
        commit_sha: None,
    };
    assert_eq!(
        decide(&accepted, "asg", submit(vec![], None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
    assert_eq!(
        decide(
            &accepted,
            "asg",
            submit(vec![], Some("  ")),
            &Observed::default()
        )
        .unwrap_err(),
        CoreError::InvalidArgument("artifacts")
    );
    let artifact = Artifact {
        uri: "https://x.test".into(),
        label: "x".into(),
    };
    assert!(decide(
        &accepted,
        "asg",
        submit(vec![artifact.clone(); MAX_ARTIFACTS], None),
        &Observed::default()
    )
    .is_ok());
    assert!(decide(
        &accepted,
        "asg",
        submit(vec![artifact; MAX_ARTIFACTS + 1], None),
        &Observed::default()
    )
    .is_err());
    let next = decide(
        &accepted,
        "asg",
        submit(vec![], Some("done")),
        &Observed::default(),
    )
    .unwrap();
    assert_eq!(next.task.submission_no, 3);
}

#[test]
fn linked_repositories_pin_the_reviewed_commit() {
    let linked = Task {
        has_linked_repository: true,
        ..task(Accepted)
    };
    let submit = |sha: Option<&str>| Command::Submit {
        version: 5,
        artifacts: vec![],
        note: Some("n".into()),
        commit_sha: sha.map(Into::into),
    };
    assert_eq!(
        decide(&linked, "asg", submit(None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    let moved = Observed {
        head_sha: Some("def".into()),
    };
    assert_eq!(
        decide(&linked, "asg", submit(Some("abc")), &moved).unwrap_err(),
        CoreError::CommitChanged
    );
    let submitted = decide(&linked, "asg", submit(Some("abc")), &Observed::default())
        .unwrap()
        .task;

    let verify = |sha: Option<&str>| Command::Verify {
        submission_no: 3,
        commit_sha: sha.map(Into::into),
    };
    assert_eq!(
        decide(&submitted, "rev", verify(None), &Observed::default()).unwrap_err(),
        CoreError::InvalidArgument("commit_sha")
    );
    assert_eq!(
        decide(&submitted, "rev", verify(Some("def")), &Observed::default()).unwrap_err(),
        CoreError::CommitChanged
    );
    assert_eq!(
        decide(&submitted, "rev", verify(Some("abc")), &moved).unwrap_err(),
        CoreError::CommitChanged
    );
    assert_eq!(
        decide(
            &submitted,
            "rev",
            verify(Some("abc")),
            &Observed {
                head_sha: Some("abc".into())
            }
        )
        .unwrap()
        .task
        .status,
        Completed
    );
}

#[test]
fn events_reach_the_right_people_and_never_the_actor() {
    let recipients = |status, actor: &str, command| {
        let decision = decide(&task(status), actor, command, &Observed::default()).unwrap();
        decision.events[0]
            .recipients
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(",")
    };
    assert_eq!(
        recipients(Offered, "asg", Command::Accept { version: 5 }),
        "req,rev"
    );
    assert_eq!(
        recipients(
            Accepted,
            "asg",
            Command::Submit {
                version: 5,
                artifacts: vec![],
                note: Some("n".into()),
                commit_sha: None
            }
        ),
        "rev"
    );
    assert_eq!(
        recipients(
            Submitted,
            "rev",
            Command::RequestChanges {
                submission_no: 2,
                reason: "x".into()
            }
        ),
        "asg"
    );
    assert_eq!(
        recipients(
            Submitted,
            "rev",
            Command::Verify {
                submission_no: 2,
                commit_sha: None
            }
        ),
        "asg,req"
    );
    assert_eq!(
        recipients(
            Offered,
            "req",
            Command::Cancel {
                version: 5,
                reason: "x".into()
            }
        ),
        "asg,rev"
    );
}

#[test]
fn status_names_round_trip() {
    for status in TaskStatus::ALL {
        assert_eq!(TaskStatus::from_name(status.name()), Some(status));
    }
    assert_eq!(TaskStatus::from_name("in_progress"), None);
}

#[test]
fn event_names_are_stable() {
    assert_eq!(EventKind::TaskOffered.name(), "task.offered");
    assert_eq!(EventKind::TaskCompleted.name(), "task.completed");
    assert_eq!(CoreError::VersionConflict.code(), "version_conflict");
}

mod departures {
    use super::*;

    #[test]
    fn assignee_leaving_active_work_reopens_it() {
        for status in [Offered, Accepted] {
            let next = apply_departure(&task(status), "asg", true).unwrap().task;
            assert_eq!((next.status, next.assignee), (Open, None));
        }
    }

    #[test]
    fn assignee_leaving_a_submission_keeps_it_reviewable() {
        let next = apply_departure(&task(Submitted), "asg", true).unwrap().task;
        assert_eq!(next.status, Submitted);
        assert!(next.assignee_departed);
        let changes = Command::RequestChanges {
            submission_no: 2,
            reason: "x".into(),
        };
        let reopened = decide(&next, "rev", changes, &Observed::default())
            .unwrap()
            .task;
        assert_eq!((reopened.status, reopened.assignee), (Open, None));
        let verify = Command::Verify {
            submission_no: 2,
            commit_sha: None,
        };
        assert_eq!(
            decide(&next, "rev", verify, &Observed::default())
                .unwrap()
                .task
                .status,
            Completed
        );
    }

    #[test]
    fn reviewer_falls_back_only_to_an_eligible_requester() {
        assert_eq!(
            apply_departure(&task(Submitted), "rev", true)
                .unwrap()
                .task
                .reviewer,
            "req"
        );
        let ineligible = apply_departure(&task(Submitted), "rev", false)
            .unwrap()
            .task;
        assert_eq!(ineligible.reviewer, "rev");
        assert!(ineligible.needs_reviewer);
        let self_review = Task {
            requester: "asg".into(),
            ..task(Submitted)
        };
        assert!(
            apply_departure(&self_review, "rev", true)
                .unwrap()
                .task
                .needs_reviewer
        );
    }

    #[test]
    fn fixing_the_reviewer_doesnt_clear_a_missing_requester() {
        let both = Task {
            reviewer: "req".into(),
            ..task(Accepted)
        };
        let next = apply_departure(&both, "req", true).unwrap().task;
        assert!(next.needs_reviewer && next.needs_requester);
        let cmd = Command::SetReviewer {
            version: next.version,
            reviewer: "rev2".into(),
        };
        let fixed = decide(&next, "admin", cmd, &Observed::default())
            .unwrap()
            .task;
        assert!(!fixed.needs_reviewer && fixed.needs_requester && fixed.needs_attention());
    }

    #[test]
    fn departures_never_complete_a_task_or_touch_finished_ones() {
        for status in TaskStatus::ALL {
            for who in ["asg", "rev", "req"] {
                if let Some(d) = apply_departure(&task(status), who, true) {
                    assert!(!d.task.status.is_terminal(), "{who} from {status:?}");
                    assert_eq!(d.task.version, 6);
                }
            }
            assert!(apply_departure(&task(status), "stranger", true).is_none());
        }
        assert!(apply_departure(&task(Completed), "asg", true).is_none());
        assert!(apply_departure(&task(Canceled), "req", true).is_none());
    }
}

/// Small deterministic generator, so a failure reproduces from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }
}

#[test]
fn invariants_hold_across_random_command_sequences() {
    let people = ["a", "b", "c", "d"];
    let mut completions = 0;
    for seed in 1..=2_000u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let requester = people[rng.next(4)];
        let new = NewTask {
            id: "t".into(),
            title: "x".into(),
            instructions: "y".into(),
            acceptance_criteria: None,
            assignee: None,
            reviewer: None,
            due_at: None,
            follow_up_of: None,
            has_linked_repository: false,
        };
        let mut current = decide_create(requester, new).unwrap().task;
        for _ in 0..40 {
            let actor = people[rng.next(4)];
            let other = people[rng.next(4)].to_string();
            let v = current.version;
            let s = current.submission_no;
            let command = match rng.next(11) {
                0 => Command::Update {
                    version: v,
                    patch: TaskPatch {
                        instructions: Some(format!("i{}", rng.next(3))),
                        ..Default::default()
                    },
                },
                1 => Command::SetReviewer {
                    version: v,
                    reviewer: other,
                },
                2 => Command::SetRequester {
                    version: v,
                    requester: other,
                },
                3 => Command::Assign {
                    version: v,
                    assignee: other,
                },
                4 => Command::Accept { version: v },
                5 => Command::Decline {
                    version: v,
                    reason: "r".into(),
                },
                6 => Command::Release {
                    version: v,
                    reason: "r".into(),
                },
                7 => Command::Submit {
                    version: v,
                    artifacts: vec![],
                    note: Some("n".into()),
                    commit_sha: None,
                },
                8 => Command::RequestChanges {
                    submission_no: s,
                    reason: "r".into(),
                },
                9 => Command::Verify {
                    submission_no: s,
                    commit_sha: None,
                },
                _ => Command::Cancel {
                    version: v,
                    reason: "r".into(),
                },
            };
            let verifying = matches!(command, Command::Verify { .. });
            let was = current.clone();
            match decide(&current, actor, command, &Observed::default()) {
                Ok(decision) => {
                    let next = decision.task;
                    assert!(next.version > was.version, "seed {seed}: version must grow");
                    assert_ne!(
                        next.assignee.as_deref(),
                        Some(next.reviewer.as_str()),
                        "seed {seed}: reviewer is the assignee"
                    );
                    assert!(
                        !was.status.is_terminal(),
                        "seed {seed}: terminal tasks don't change"
                    );
                    if next.status == Completed {
                        assert!(
                            verifying && was.status == Submitted,
                            "seed {seed}: only review completes"
                        );
                        assert_ne!(
                            was.assignee.as_deref(),
                            Some(actor),
                            "seed {seed}: self sign-off"
                        );
                        completions += 1;
                    }
                    assert!(
                        next.submission_no >= was.submission_no,
                        "seed {seed}: submissions don't rewind"
                    );
                    current = next;
                }
                Err(_) => assert_eq!(current, was, "seed {seed}: refusal changes nothing"),
            }
        }
    }
    assert!(completions > 0, "the walk must actually reach completion");
}
