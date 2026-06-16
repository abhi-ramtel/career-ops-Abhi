# Story Bank — Master STAR+R Stories

This file accumulates your best interview stories over time. Each evaluation (Block F) adds new stories here. Instead of memorizing 100 answers, maintain 5-10 deep stories that you can bend to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank:
   - "Tell me about yourself" → combine 2-3 stories into a narrative
   - "Tell me about your most impactful project" → pick your highest-impact story
   - "Tell me about a conflict you resolved" → find a story with a Reflection

## Stories

<!-- Stories will be added here as you evaluate offers -->
<!-- Format:
### [Theme] Story Title
**Source:** Report #NNN — Company — Role
**S (Situation):** ...
**T (Task):** ...
**A (Action):** ...
**R (Result):** ...
**Reflection:** What I learned / what I'd do differently
**Best for questions about:** [list of question types this story answers]
-->

### Applied AI Product: CarbonProxy
**Source:** Report #003 — OpenAI — Full-Stack Software Engineer, Applied Foundations
**S (Situation):** The app needed to reduce LLM cost and context bloat without losing utility.
**T (Task):** Build a product that combined a UI, API, and smarter inference routing.
**A (Action):** Built React + FastAPI + SQLite services, added async background tasks, and implemented semantic KV caching and routing logic.
**R (Result):** Reduced session token bloat from 2,400 to 340 tokens and shipped a hackathon-winning product.
**Reflection:** Good AI products need orchestration, memory discipline, and clear user value.
**Best for questions about:** AI product judgment, full-stack delivery, trade-offs, cost control

### Production Systems: Founding Engineer Payments Platform
**Source:** Report #003 — OpenAI — Full-Stack Software Engineer, Applied Foundations
**S (Situation):** A global payments system needed to stay reliable under heavy transaction load.
**T (Task):** Design services that would not cascade-fail if one component broke.
**A (Action):** Split the platform into independent Go services and used PostgreSQL for strict wallet and ledger behavior.
**R (Result):** Built a scalable payments platform and secure wallet engine with durable auditability.
**Reflection:** Clear boundaries and data integrity matter more than piling features onto a fragile core.
**Best for questions about:** reliability, architecture, ownership, systems thinking

### Performance: Cytocybernetics Pipeline Refactor
**Source:** Report #003 — OpenAI — Full-Stack Software Engineer, Applied Foundations
**S (Situation):** Iterative Python logic was slowing high-volume processing.
**T (Task):** Remove the bottleneck without changing the output.
**A (Action):** Rewrote the pipeline with vectorized Pandas and NumPy operations.
**R (Result):** Increased throughput by 60% and removed the main bottleneck.
**Reflection:** Before optimizing, identify the real bottleneck.
**Best for questions about:** performance tuning, data pipelines, pragmatic debugging

### Full-Stack Delivery: SharePlay
**Source:** Report #003 — OpenAI — Full-Stack Software Engineer, Applied Foundations
**S (Situation):** A live collaborative music product needed a real-time user experience.
**T (Task):** Ship the product end to end.
**A (Action):** Built the full stack with React, TypeScript, backend services, and real-time playback and recommendation logic.
**R (Result):** Delivered a working collaborative app with host and guest flows.
**Reflection:** Product value shows up when backend, frontend, and UX all move together.
**Best for questions about:** end-to-end ownership, frontend/backend collaboration, product delivery

### Support and Debugging: UB Tech Consultant
**Source:** Report #003 — OpenAI — Full-Stack Software Engineer, Applied Foundations
**S (Situation):** Users across the university had complex technical, authentication, and security issues.
**T (Task):** Keep systems running for more than 2,000 users.
**A (Action):** Diagnosed OS, networking, and enterprise software issues across Windows, macOS, and Linux.
**R (Result):** Resolved problems quickly and kept users moving.
**Reflection:** Support work sharpens diagnosis, prioritization, and communication under pressure.
**Best for questions about:** troubleshooting, user empathy, incident handling
