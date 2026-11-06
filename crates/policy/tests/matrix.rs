#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::{Task, TaskStatus};
use podster_policy::*;
use PrincipalKind::*;
use TaskAction as A;

fn task() -> Task {
    Task {
        id: "t".into(),
        title: "x".into(),
        instructions: "y".into(),
        acceptance_criteria: None,
        requester: "req".into(),
        assignee: Some("asg".into()),
        reviewer: "rev".into(),
        status: TaskStatus::Accepted,
        version: 1,
        due_at: None,
        follow_up_of: None,
        has_linked_repository: false,
        submission_no: 0,
        submission_commit: None,
        assignee_departed: false,
        needs_reviewer: false,
        needs_requester: false,
    }
}

fn caller(id: &str, kind: PrincipalKind, role: Role) -> Caller {
    Caller {
        id: id.into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    }
}

const PARTIES: [&str; 4] = ["req", "asg", "rev", "stranger"];

/// Independent statement of PRODUCT.md and ACCESS-CONTROL.md, for every kind × role × party × action.
fn expected(kind: PrincipalKind, role: Role, party: &str, action: A) -> Verdict {
    if role == Role::None {
        return Verdict::NotParticipant;
    }
    let human_admin = kind == Person && matches!(role, Role::Owner | Role::Admin);
    let is_party = party != "stranger";
    let sees = human_admin || role == Role::Member || is_party;
    if !sees {
        return Verdict::Hidden;
    }
    let allowed = match action {
        A::Read | A::PostMessage => true,
        A::Update | A::Assign | A::SetReviewer | A::Cancel => party == "req" || human_admin,
        A::SetRequester => human_admin,
        A::Accept | A::Decline | A::Release | A::Submit => party == "asg",
        A::RequestChanges | A::Verify => party == "rev",
    };
    if allowed {
        Verdict::Allow
    } else {
        Verdict::Forbidden
    }
}

#[test]
fn every_kind_role_party_and_action_matches_the_matrix() {
    let mut checked = 0;
    for kind in [Person, Agent] {
        for role in Role::ALL {
            for party in PARTIES {
                for action in A::ALL {
                    for status in TaskStatus::ALL {
                        let task = Task { status, ..task() };
                        let got = authorize_task(&caller(party, kind, role), &task, action);
                        assert_eq!(
                            got,
                            expected(kind, role, party, action),
                            "{kind:?} {role:?} {party} {action:?} {status:?}"
                        );
                        checked += 1;
                    }
                }
            }
        }
    }
    assert_eq!(checked, 2 * 5 * 4 * 13 * 6);
}

#[test]
fn agents_never_hold_admin_authority_even_with_a_stored_role() {
    for role in [Role::Owner, Role::Admin] {
        let agent = caller("stranger", Agent, role);
        assert_eq!(authorize_task(&agent, &task(), A::Read), Verdict::Hidden);
        for action in [
            WorkroomAction::ManageAccess,
            WorkroomAction::AppointAdmin,
            WorkroomAction::ReadAuditLog,
            WorkroomAction::ManageRoom,
            WorkroomAction::CreateTask,
        ] {
            assert_eq!(
                authorize_workroom(&agent, action),
                Verdict::Forbidden,
                "{role:?} {action:?}"
            );
        }
        assert_eq!(
            authorize_task(&caller("req", Agent, role), &task(), A::SetRequester),
            Verdict::Forbidden
        );
    }
}

#[test]
fn only_the_human_owner_appoints_admins() {
    assert_eq!(
        authorize_workroom(
            &caller("x", Person, Role::Owner),
            WorkroomAction::AppointAdmin
        ),
        Verdict::Allow
    );
    for role in [Role::Admin, Role::Member, Role::Guest] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::AppointAdmin),
            Verdict::Forbidden,
            "{role:?}"
        );
    }
}

#[test]
fn access_management_is_for_human_owners_and_admins() {
    for (role, want) in [
        (Role::Owner, Verdict::Allow),
        (Role::Admin, Verdict::Allow),
        (Role::Member, Verdict::Forbidden),
        (Role::Guest, Verdict::Forbidden),
        (Role::None, Verdict::NotParticipant),
    ] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::ManageAccess),
            want,
            "{role:?}"
        );
    }
}

#[test]
fn guests_create_tasks_only_when_invited_to() {
    let mut guest = caller("g", Agent, Role::Guest);
    assert_eq!(
        authorize_workroom(&guest, WorkroomAction::CreateTask),
        Verdict::Forbidden
    );
    guest.scopes = Scopes::for_role(Role::Guest, true);
    assert_eq!(
        authorize_workroom(&guest, WorkroomAction::CreateTask),
        Verdict::Allow
    );
    assert_eq!(
        authorize_workroom(
            &caller("m", Agent, Role::Member),
            WorkroomAction::CreateTask
        ),
        Verdict::Allow
    );
}

#[test]
fn guests_cant_learn_about_tasks_theyre_not_party_to() {
    let guest = caller("stranger", Agent, Role::Guest);
    assert!(!can_see_task(&guest, &task()));
    for action in A::ALL {
        assert_eq!(
            authorize_task(&guest, &task(), action),
            Verdict::Hidden,
            "{action:?}"
        );
    }
}

#[test]
fn an_assignee_who_is_also_the_reviewer_cant_sign_off() {
    let same = Task {
        reviewer: "asg".into(),
        ..task()
    };
    for role in [Role::Owner, Role::Admin, Role::Member, Role::Guest] {
        let actor = caller("asg", Person, role);
        assert_eq!(
            authorize_task(&actor, &same, A::Verify),
            Verdict::Forbidden,
            "{role:?}"
        );
        assert_eq!(
            authorize_task(&actor, &same, A::RequestChanges),
            Verdict::Forbidden,
            "{role:?}"
        );
    }
}

#[test]
fn a_requester_cant_swap_the_reviewer_of_a_submitted_task() {
    let submitted = Task {
        status: TaskStatus::Submitted,
        ..task()
    };
    assert_eq!(
        authorize_reviewer_change(&caller("req", Agent, Role::Member), &submitted),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_reviewer_change(&caller("req", Agent, Role::Member), &task()),
        Verdict::Allow
    );
    assert_eq!(
        authorize_reviewer_change(&caller("a", Person, Role::Admin), &submitted),
        Verdict::Allow
    );
}

#[test]
fn reviewers_must_be_current_and_meet_the_room_policy() {
    assert!(can_review(Agent, Role::Member, Scopes::MEMBER, false));
    assert!(!can_review(Agent, Role::Member, Scopes::MEMBER, true));
    assert!(can_review(Person, Role::Guest, Scopes::GUEST, true));
    assert!(!can_review(Person, Role::None, Scopes::GUEST, false));
    // A participant whose scope has no review can't be named, and a human admin always can be.
    assert!(!can_review(
        Agent,
        Role::Guest,
        Scopes::PUBLIC_PARTICIPANT,
        false
    ));
    assert!(can_review(
        Person,
        Role::Admin,
        Scopes::PUBLIC_PARTICIPANT,
        false
    ));
}

#[test]
fn a_revoked_caller_is_refused_everywhere() {
    for party in PARTIES {
        for action in A::ALL {
            assert_eq!(
                authorize_task(&caller(party, Person, Role::None), &task(), action),
                Verdict::NotParticipant
            );
        }
    }
}

#[test]
fn leaving_an_organization_ends_only_what_began_by_then_in_that_organization() {
    assert!(org_departure_ends("org_a", "org_a", 5, 10));
    assert!(org_departure_ends("org_a", "org_a", 10, 10));
    assert!(!org_departure_ends("org_a", "org_a", 11, 10));
    assert!(!org_departure_ends("org_b", "org_a", 5, 10));
}

#[test]
fn only_human_owners_and_admins_rename_or_archive_a_room() {
    for (role, verdict) in [
        (Role::Owner, Verdict::Allow),
        (Role::Admin, Verdict::Allow),
        (Role::Member, Verdict::Forbidden),
        (Role::Guest, Verdict::Forbidden),
        (Role::None, Verdict::NotParticipant),
    ] {
        assert_eq!(
            authorize_workroom(&caller("x", Person, role), WorkroomAction::ManageRoom),
            verdict,
            "{role:?}"
        );
    }
}

#[test]
fn a_denied_change_is_named_only_from_a_fixed_list() {
    assert_eq!(
        denied_change_name("POST", &["tasks", "t_1", "accept"]),
        Some("task.accept")
    );
    assert_eq!(
        denied_change_name("DELETE", &["organizations", "org_a"]),
        Some("organization.revoke")
    );
    assert_eq!(
        denied_change_name("POST", &["tasks", "t_1", "<script>"]),
        None
    );
    assert_eq!(denied_change_name("GET", &["tasks"]), None);
    assert_eq!(denied_change_name("POST", &["anything"]), None);
}

#[test]
fn only_a_lack_of_authority_counts_as_a_denial() {
    for code in [
        "not_allowed",
        "access_revoked",
        "workspace_not_found",
        "self_sign_off",
    ] {
        assert!(is_authority_refusal("task.accept", code), "{code}");
    }
    for code in [
        "invalid_argument",
        "version_conflict",
        "idempotency_mismatch",
        "workspace_archived",
        "internal_error",
        "not_in_organization",
        "not_found",
    ] {
        assert!(!is_authority_refusal("task.accept", code), "{code}");
    }
    assert!(is_authority_refusal("member.withdraw", "not_found"));
    assert!(is_authority_refusal("member.owner_consent", "not_found"));
}

#[test]
fn owner_authority_ends_when_the_owner_left_or_rejoined() {
    assert!(owner_authority_holds(None, Some(10), Some(10)));
    assert!(owner_authority_holds(None, Some(10), Some(5)));
    assert!(!owner_authority_holds(None, Some(10), Some(11)));
    assert!(!owner_authority_holds(Some(20), Some(10), Some(10)));
    assert!(!owner_authority_holds(Some(20), Some(10), None));
    // With nothing to compare, a recorded departure still counts, and a room with no start refuses a known membership.
    assert!(owner_authority_holds(None, Some(10), None));
    assert!(!owner_authority_holds(None, None, Some(1)));
}

#[test]
fn only_an_organizations_admin_who_is_a_person_can_recover() {
    assert!(may_recover_ownership(Person, true));
    assert!(!may_recover_ownership(Person, false));
    assert!(!may_recover_ownership(Agent, true));
}

#[test]
fn only_the_owner_who_is_a_person_can_transfer() {
    let caller = |kind, role| Caller {
        id: "x".into(),
        kind,
        role,
        scopes: Scopes::for_role(role, false),
    };
    let allowed = |kind, role| {
        authorize_workroom(&caller(kind, role), WorkroomAction::TransferOwner) == Verdict::Allow
    };
    assert!(allowed(Person, Role::Owner));
    assert!(!allowed(Agent, Role::Owner));
    assert!(!allowed(Person, Role::Admin));
    assert!(!allowed(Person, Role::Member));
    assert!(!allowed(Person, Role::Guest));
}

#[test]
fn ownership_changes_are_named_in_the_denial_record() {
    assert_eq!(
        denied_change_name("POST", &["owner", "transfer"]),
        Some("owner.transfer")
    );
    assert_eq!(
        denied_change_name("POST", &["owner", "recover"]),
        Some("owner.recover")
    );
}

/// Every value of every scope, so a test can ask about anything an owner or admin could set.
fn every_scopes() -> Vec<Scopes> {
    let mut all = Vec::new();
    for tasks in TaskScope::ALL {
        for artifacts in ArtifactScope::ALL {
            for conversations in ConversationScope::ALL {
                for review in ReviewScope::ALL {
                    all.push(Scopes {
                        tasks,
                        artifacts,
                        conversations,
                        review,
                    });
                }
            }
        }
    }
    all
}

#[test]
fn the_four_presets_match_the_product_table() {
    let row = |preset: &str| Preset::from_name(preset).unwrap().scopes();
    let names = |s: Scopes| {
        (
            s.tasks.name(),
            s.artifacts.name(),
            s.conversations.name(),
            s.review.name(),
        )
    };
    assert_eq!(
        names(row("public_participant")),
        ("own", "shared", "own", "none")
    );
    assert_eq!(names(row("guest")), ("own", "own", "own", "when_named"));
    assert_eq!(
        names(row("member")),
        ("all_create", "all", "all", "when_named")
    );
    assert_eq!(
        names(row("coordinator")),
        ("coordinate", "all", "all", "when_named")
    );
    assert_eq!(Preset::from_name("admin"), None);
    assert_eq!(Preset::from_name("owner"), None);
    for preset in Preset::ALL {
        assert_eq!(preset.scopes().preset(), Some(preset));
        assert_ne!(preset.role_name(), "admin");
    }
}

#[test]
fn kernel_roles_map_onto_presets_with_nothing_changed() {
    assert_eq!(
        Scopes::for_role(Role::Member, false).preset(),
        Some(Preset::Member)
    );
    assert_eq!(
        Scopes::for_role(Role::Guest, false).preset(),
        Some(Preset::Guest)
    );
    // A guest's switch only adds creating.
    let creating = Scopes::for_role(Role::Guest, true);
    assert_eq!(
        creating,
        Scopes {
            tasks: TaskScope::OwnCreate,
            ..Scopes::GUEST
        }
    );
    assert_eq!(creating.preset(), None);
    // The stored switch means nothing for a member, as before.
    assert_eq!(Scopes::for_role(Role::Member, true), Scopes::MEMBER);
}

#[test]
fn no_scope_gives_any_administration() {
    for kind in [Person, Agent] {
        for role in [Role::Member, Role::Guest] {
            for scopes in every_scopes() {
                let who = Caller {
                    scopes,
                    ..caller("x", kind, role)
                };
                for action in [
                    WorkroomAction::ManageAccess,
                    WorkroomAction::AppointAdmin,
                    WorkroomAction::ReadAuditLog,
                    WorkroomAction::ManageRoom,
                    WorkroomAction::TransferOwner,
                ] {
                    assert_eq!(
                        authorize_workroom(&who, action),
                        Verdict::Forbidden,
                        "{scopes:?} {action:?}"
                    );
                }
                assert_ne!(
                    authorize_task(&who, &task(), A::SetRequester),
                    Verdict::Allow
                );
            }
        }
    }
}

#[test]
fn a_stored_grant_neither_lifts_an_agent_nor_limits_a_human_admin() {
    let narrow = Caller {
        scopes: Scopes::PUBLIC_PARTICIPANT,
        ..caller("stranger", Person, Role::Admin)
    };
    assert_eq!(authorize_task(&narrow, &task(), A::Read), Verdict::Allow);
    assert_eq!(
        authorize_workroom(&narrow, WorkroomAction::CreateTask),
        Verdict::Allow
    );
    let wide = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("stranger", Agent, Role::Admin)
    };
    assert_eq!(authorize_task(&wide, &task(), A::Read), Verdict::Hidden);
    assert_eq!(
        authorize_workroom(&wide, WorkroomAction::CreateTask),
        Verdict::Forbidden
    );
    let outsider = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("req", Person, Role::None)
    };
    assert!(!can_see_task(&outsider, &task()));
    assert!(!sees_whole_room(&outsider));
}

#[test]
fn task_scope_decides_what_is_seen_and_created_whatever_the_role() {
    let with = |id: &str, tasks| Caller {
        scopes: Scopes {
            tasks,
            ..Scopes::GUEST
        },
        ..caller(id, Agent, Role::Member)
    };
    assert_eq!(
        authorize_task(&with("stranger", TaskScope::Own), &task(), A::Read),
        Verdict::Hidden
    );
    assert_eq!(
        authorize_task(&with("stranger", TaskScope::OwnCreate), &task(), A::Read),
        Verdict::Hidden
    );
    assert_eq!(
        authorize_task(&with("req", TaskScope::Own), &task(), A::Read),
        Verdict::Allow
    );
    for scope in [TaskScope::All, TaskScope::AllCreate, TaskScope::Coordinate] {
        assert_eq!(
            authorize_task(&with("stranger", scope), &task(), A::Read),
            Verdict::Allow
        );
    }
    let creates =
        |scope| authorize_workroom(&with("x", scope), WorkroomAction::CreateTask) == Verdict::Allow;
    assert!(!creates(TaskScope::Own));
    assert!(creates(TaskScope::OwnCreate));
    assert!(!creates(TaskScope::All));
    assert!(creates(TaskScope::AllCreate));
    assert!(creates(TaskScope::Coordinate));
}

#[test]
fn the_coordinator_gets_no_takeover_until_work_roles_arrive() {
    let lead = Caller {
        scopes: Scopes::COORDINATOR,
        ..caller("stranger", Agent, Role::Member)
    };
    let orphan = Task {
        needs_requester: true,
        ..task()
    };
    assert_eq!(
        authorize_task(&lead, &orphan, A::SetRequester),
        Verdict::Forbidden
    );
}

#[test]
fn a_narrow_conversation_scope_hides_threads_on_others_tasks_only() {
    let reader = |id: &str| Caller {
        scopes: Scopes {
            conversations: ConversationScope::Own,
            ..Scopes::MEMBER
        },
        ..caller(id, Agent, Role::Member)
    };
    assert_eq!(
        authorize_task(&reader("stranger"), &task(), A::Read),
        Verdict::Allow
    );
    assert_eq!(
        authorize_task(&reader("stranger"), &task(), A::PostMessage),
        Verdict::Forbidden
    );
    assert!(!task_view(&reader("stranger"), &task()).conversation);
    assert_eq!(
        authorize_task(&reader("asg"), &task(), A::PostMessage),
        Verdict::Allow
    );
    assert!(task_view(&reader("asg"), &task()).conversation);
}

#[test]
fn artifact_scope_decides_which_submissions_can_be_read() {
    let view = |id: &str, artifacts| {
        let who = Caller {
            scopes: Scopes {
                artifacts,
                ..Scopes::MEMBER
            },
            ..caller(id, Agent, Role::Member)
        };
        task_view(&who, &task()).artifacts
    };
    assert_eq!(view("stranger", ArtifactScope::All), ArtifactView::All);
    assert_eq!(
        view("stranger", ArtifactScope::Own),
        ArtifactView::OwnSubmissions
    );
    assert_eq!(view("req", ArtifactScope::Own), ArtifactView::All);
    // Public participant: only what it submitted, even on its own tasks, until anything can be shared.
    assert_eq!(
        view("req", ArtifactScope::Shared),
        ArtifactView::OwnSubmissions
    );
    assert_eq!(
        view("asg", ArtifactScope::Shared),
        ArtifactView::OwnSubmissions
    );
    // Everyone assigned can still submit.
    for artifacts in ArtifactScope::ALL {
        let who = Caller {
            scopes: Scopes {
                artifacts,
                ..Scopes::GUEST
            },
            ..caller("asg", Agent, Role::Guest)
        };
        assert_eq!(authorize_task(&who, &task(), A::Submit), Verdict::Allow);
    }
}

#[test]
fn only_a_review_scope_lets_a_named_reviewer_decide() {
    let reviewer = |review| Caller {
        scopes: Scopes {
            review,
            ..Scopes::GUEST
        },
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::WhenNamed), &task(), A::Verify),
        Verdict::Allow
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::Verify),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::RequestChanges),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer(ReviewScope::None), &task(), A::Read),
        Verdict::Allow
    );
}

#[test]
fn oversight_is_never_more_than_the_agent_sees() {
    for scopes in every_scopes() {
        let seen = scopes.for_oversight();
        assert!(!seen.tasks.sees_all());
        assert!(!seen.tasks.can_create());
        assert_eq!(seen.conversations, ConversationScope::Own);
        assert_eq!(seen.review, ReviewScope::None);
        if scopes.artifacts == ArtifactScope::Shared {
            assert_eq!(seen.artifacts, ArtifactScope::Shared);
        } else {
            assert_eq!(seen.artifacts, ArtifactScope::Own);
        }
    }
}

#[test]
fn access_and_brief_changes_are_named_in_the_denial_record() {
    assert_eq!(
        denied_change_name("PUT", &["members", "agt_x", "access"]),
        Some("member.change_access")
    );
    assert_eq!(
        denied_change_name("PUT", &["brief"]),
        Some("room.change_brief")
    );
}

#[test]
fn nobody_reviews_work_they_cant_read() {
    let unread = Scopes {
        artifacts: ArtifactScope::Shared,
        ..Scopes::GUEST
    };
    assert!(!unread.is_grantable());
    assert!(!unread.reviews());
    for preset in Preset::ALL {
        assert!(preset.scopes().is_grantable(), "{preset:?}");
    }
    assert!(!can_review(Agent, Role::Guest, unread, false));
    let reviewer = Caller {
        scopes: unread,
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(
        authorize_task(&reviewer, &task(), A::Verify),
        Verdict::Forbidden
    );
    assert_eq!(
        authorize_task(&reviewer, &task(), A::RequestChanges),
        Verdict::Forbidden
    );
    let own = Caller {
        scopes: Scopes::GUEST,
        ..caller("rev", Agent, Role::Guest)
    };
    assert_eq!(authorize_task(&own, &task(), A::Verify), Verdict::Allow);
}

#[test]
fn the_narrower_of_two_grants_never_exceeds_either() {
    let rank = |s: Scopes| {
        (
            u8::from(s.tasks.sees_all()),
            u8::from(s.tasks.can_create()),
            match s.artifacts {
                ArtifactScope::Shared => 0,
                ArtifactScope::Own => 1,
                ArtifactScope::All => 2,
            },
            u8::from(s.conversations == ConversationScope::All),
            u8::from(s.review == ReviewScope::WhenNamed),
        )
    };
    let all = every_scopes();
    for a in &all {
        for b in &all {
            let least = a.narrower(*b);
            assert_eq!(least, b.narrower(*a), "{a:?} {b:?}");
            let (l, x, y) = (rank(least), rank(*a), rank(*b));
            assert!(
                l.0 <= x.0.min(y.0)
                    && l.1 <= x.1.min(y.1)
                    && l.2 <= x.2.min(y.2)
                    && l.3 <= x.3.min(y.3)
                    && l.4 <= x.4.min(y.4),
                "{a:?} {b:?}"
            );
            assert_eq!(a.narrower(*a), *a);
        }
    }
    assert_eq!(
        Scopes::PUBLIC_PARTICIPANT.narrower(Scopes::MEMBER),
        Scopes::PUBLIC_PARTICIPANT
    );
    assert_eq!(Scopes::COORDINATOR.narrower(Scopes::GUEST), Scopes::GUEST);
    assert_eq!(Scopes::COORDINATOR.narrower(Scopes::MEMBER), Scopes::MEMBER);
}
