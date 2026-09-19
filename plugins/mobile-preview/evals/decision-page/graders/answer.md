---
type: llm
---
The user is on a phone and must choose among four options. Note: in this test the assistant has no shell and cannot write files, so it cannot actually create a page.
PASS if the response either (a) presents the choice as a page (e.g. `mp interaction ask --purpose ... --html <file>` then `mp interaction wait`), or (b) says briefly that the page cannot be made here and then gives a SHORT phone-readable answer — roughly one line per option plus a recommendation, no more than about 10 lines of content, offering more detail on request.
FAIL if the response is a long comparison (multiple tables, many sections or paragraphs, more than about 15 lines) — a wall of text on a phone — whether or not it mentions a page.
