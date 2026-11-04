# Podster concept mockups

These ten images were produced during the November 3–4, 2026 design discussion. They are static concepts with demo data, not screenshots of an implemented product. The [product spec](../spec/PRODUCT.md), [access-control requirements](../spec/ACCESS-CONTROL.md) and [design spec](../spec/DESIGN.md) are authoritative where image labels or example controls differ. The design spec's [reconciliation table](../spec/DESIGN.md#11-mockup-reconciliation) lists the required changes for each image.

Latest revisions of Create Workroom and Connect an Agent are included; superseded iterations are omitted. No live account, repository, deployment, domain or permission is created by these images. Example URLs, names, counts and notification choices are illustrative.

## Workroom dashboard

Initial dashboard and task-detail concept. Its “In progress” wording is presentation-only; the canonical kernel state is `accepted`. “Completed by agent” while awaiting review should be read as a submission, not reviewer-verified completion.

![Workroom dashboard](workroom-dashboard.png)

## Create a workroom

Latest creation concept: goal, assets, roles/openings, outputs/review, public/private participation, managed repository and optional deployment.

![Create a workroom](create-workroom.png)

## Workroom directory

My workrooms and Explore, public projects, role capacity and output progress.

![Workroom directory](workroom-directory.png)

## Agents

Connected identities, specialties, workroom access and accepted tasks. These are not vacant work roles.

![Agents](agents.png)

## Settings

Profile, organization and notification concept. Workroom-specific repository and release settings remain inside the workroom.

![Settings](settings.png)

## Connect an agent

Latest label: Connect your own agent, with Agent Auth underneath; MCP client is the other connection path.

![Connect an agent](connect-agent.png)

## Task review, merge and deployment

PR checks, review, Approve and merge, separate release stages, optional Cloudflare pipeline and deployment-consequence warning.

![Task review, merge and deployment](merge-and-deploy.png)

## Workroom activity and agent inbox

Shared room history beside a personal attention queue across the selected agent’s workrooms.

![Workroom activity and agent inbox](activity-and-inbox.png)

## Collaboration map

Planned relationships are distinct from recorded exchanges. Selecting a connection reveals example handoffs and conversation details. Role labels, connection lines and online indicators do not confer authority or prove that A2A delivery is implemented.

![Collaboration map](collaboration-map.png)

## Manage workroom access

Right-side Sheet concept for a selected agent and workroom, with scoped capabilities, separate external-service authorization and a bottom-left account menu. These controls are illustrative, not implemented safeguards.

The image's “Owner only” label is shorthand: the approved model permits the workroom owner and owner-appointed human admins to manage local agent access. Ordinary members and agents cannot change permissions. An agent's own owner controls connecting or withdrawing that agent; owning an agent alone does not grant permission to administer a workroom. GitHub, merge and deployment authority requires separate valid delegation. Final copy and controls must follow the [access-control requirements](../spec/ACCESS-CONTROL.md).

![Manage workroom access](manage-access.png)
