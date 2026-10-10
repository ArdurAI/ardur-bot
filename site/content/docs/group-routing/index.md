---
title: "Group message recipients"
description: "The composer shows **To <names>** while you draft a group message. Nothing is sent until"
source_path: "docs/group-routing.md"
---

> [Source: docs/group-routing.md](https://github.com/ArdurAI/ardur-bot/blob/__ARDUR_BOT_SOURCE_REF__/docs/group-routing.md). Edit the source file, then run `python3 site/scripts/sync_docs.py` to refresh this page.

The composer shows **To &lt;names&gt;** while you draft a group message. Nothing is sent until
you send it. Web and desktop share this composer; mobile shows the same names above its
native composer.

An unaddressed message goes to **one** member. For example, “Each member, reply with your
model” does not broadcast. Without a reply or explicit address, the order is:

1. The room coordinator, if it is still a member.
2. The member with the most recently created run in this room.
3. The space coordinator, if it is a member of this room.
4. The first member in the saved roster.

Equal run creation times use run ID descending, so the preview and send use the same tie
break. A reply targets the member who wrote that message before these defaults.

## Ask more than one member

- @One targets that member.
- @One @Two targets those two members.
- @everyone targets every member.
- An opening address such as “One and Two, compare notes” also targets those members.
- The existing short command “Everyone, each of you reply” asks each member. Other prose
  mentioning everyone is not a broadcast instruction.
- Coordinator task corrections keep their existing control route; naming a member in a
  correction does not start a new task for that member.

The room limit controls **simultaneous work**, not how many recipients can be selected.
The default is four, adjustable from one to eight in group settings. Selected members
beyond available places stay queued. **Queued: &lt;names&gt;** shows members with saved queued
runs; it does not estimate future work or claim they have started.

## Limits

The preview uses the room's latest loaded routing state. Another send, a coordinator
change, or a member change can alter the destination before admission. The backend
rechecks current ownership, roster and routing when you send; the preview reserves no
place and grants no permission. Accepted room messages refresh routing metadata. A
missing routing snapshot from an older server hides the preview rather than guessing.

Selecting a different group or a routine, or entering a slash command, hides this room's
preview because that action can choose a different destination. Completed answers,
owner acceptance and approval for tool effects remain separate.
