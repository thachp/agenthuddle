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
        guest_can_create: false,
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
    guest.guest_can_create = true;
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
    assert!(can_review(Agent, Role::Member, false));
    assert!(!can_review(Agent, Role::Member, true));
    assert!(can_review(Person, Role::Guest, true));
    assert!(!can_review(Person, Role::None, false));
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
