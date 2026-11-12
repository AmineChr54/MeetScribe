---
name: meeting-summary
description: Summarize a meeting transcript (for example one exported from MeetScribe with "Copy for LLM") into sections, then list the to-dos for the user and for everyone else, then the open questions, and save it as a Markdown file. Use when the user asks to summarize a meeting, write meeting notes, or pull to-dos out of a transcript.
---

# Meeting summary

Turn a meeting transcript into short, accurate notes the user can act on.

## Input

- The transcript the user pasted, or a transcript file they point to.
- MeetScribe labels the user's microphone as **You** and everyone else as **Them**
  (or with speaker names, when voice labels were on). "You" is the user.
- Live transcripts can contain mishearings. When a word looks wrong, use the most likely
  term from context, the project's docs, or a glossary the user gives. Never invent content
  to fill a gap; mark it as unclear instead.

## Before writing

1. Ask where to save the file, unless the user already named a folder or the project's
   instructions say where meeting notes go. Never assume a path.
2. Read any project docs or glossary the user points to, so names and terms are spelled right.
3. Write in the language the meeting was held in, unless the user asks for another.

## Output

Save one Markdown file named `YYYY-MM-DD <short topic>.md` (the meeting's date) with:

```markdown
# <Topic> (YYYY-MM-DD)

Participants: <names if known, else "You and others">

## Summary
### <Section per topic discussed>
- What was discussed, decided, and why. Short bullets, facts only.

## To-dos
### For me
- [ ] <task> (due date or owner details if stated)
### For others
- [ ] <person or "unassigned">: <task>

## Open questions
- <question>: who should answer it, if known
```

## Rules

- Order sections by topic, not by time, and keep each one short.
- State decisions as decisions. Keep ideas and maybes apart from them.
- To-dos must be concrete actions. Only assign an owner the transcript supports;
  otherwise write "unassigned".
- Keep everything only in the file the user asked for. Do not paste the transcript, quotes or
  personal details anywhere else (issues, commits, chats, public pages).
- Finish by telling the user the file path and the number of to-dos and open questions.
