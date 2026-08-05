---
name: laws-of-ux
description: "Apply evidence-based UX psychology laws when building web applications and interfaces. Use this skill whenever designing or reviewing UI/UX for web apps, dashboards, landing pages, forms, navigation systems, or any user-facing interface. Also triggers on: 'UX review', 'usability', 'user experience design', 'make this more usable', 'improve UX', 'UX patterns', 'interface design', 'is this good UX', 'accessibility and usability', or any mention of specific UX laws (Fitts's Law, Hick's Law, Jakob's Law, etc.)."
---

# Laws of UX — Web App Design Skill

> **Source:** [lawsofux.com](https://lawsofux.com) by Jon Yablonski · 30 evidence-based psychology laws for UX design

---

## How This Skill Works

### Mode A: Quick Question (one law, yes/no fix)

User asks: _"Is this button big enough?"_ / _"Should I add another nav item?"_

1. Read **Quick Reference** table → find the relevant law(s)
2. Read **that law's detail section only**
3. Answer directly: principle + ✅/❌ verdict + one concrete suggestion
4. Skip everything else (routing, conflicts, scripts, checklist)

### Mode B: Full Review / Design Session

User asks: _"Review my dashboard"_ / _"Help me design a checkout flow"_

1. **Understand context** — what's being built? (Use Context Routing below)
2. **Select 3–7 relevant laws** from routing table + Quick Reference
3. **Give specific feedback** per law: principle → their code/UI → concrete fix → severity (🔴🟡🔵)
4. **Check conflicts** between selected laws → [When Laws Conflict](#when-laws-conflict)
5. **Output prioritized findings list** using [Review Workflow](#review-workflow)
6. **Stakeholder scripts** (optional) — if user needs to defend decisions → [Stakeholder Communication](#stakeholder-communication)

---

## Context Routing: What You're Building → Which Laws Matter

### Forms & Input (signup, checkout, settings, search)

| Priority        | Law                 | Why                                                   |
| --------------- | ------------------- | ----------------------------------------------------- |
| 🔴 Critical     | Postel's Law        | Accept varied input, normalize internally             |
| 🔴 Critical     | Hick's Law          | Break long forms into steps; limit choices per screen |
| 🔴 Critical     | Doherty Threshold   | Inline validation < 400ms; optimistic updates         |
| 🟡 Important    | Miller's Law        | ~7 fields per step max                                |
| 🟡 Important    | Tesler's Law        | Smart defaults absorb complexity                      |
| 🟡 Important    | Fitts's Law         | Touch targets ≥ 44px; adequate spacing                |
| 🔵 Nice-to-have | Von Restorff Effect | Primary CTA stands out                                |
| 🔵 Nice-to-have | Peak-End Rule       | Success state is delightful                           |

**Common anti-pattern:** Wall of 15+ fields, strict input formatting, no inline validation, identical Submit/Cancel.

---

### Dashboards & Data-Dense Pages

| Priority        | Law                  | Why                                             |
| --------------- | -------------------- | ----------------------------------------------- |
| 🔴 Critical     | Cognitive Load       | One concept per screen; kill decorative noise   |
| 🔴 Critical     | Chunking             | Group metrics into cards/sections with headings |
| 🔴 Critical     | Law of Proximity     | Related items close; groups loosely spaced      |
| 🟡 Important    | Law of Similarity    | Same metric type = same visual treatment        |
| 🟡 Important    | Law of Common Region | Cards/panels create clear boundaries            |
| 🟡 Important    | Miller's Law         | ~7 chunks visible; paginate/filter rest         |
| 🟡 Important    | Selective Attention  | Put key metrics in user's goal-path             |
| 🔵 Nice-to-have | Goal-Gradient Effect | Progress bars toward goals                      |

**Common anti-pattern:** 50 metrics flat grid, no grouping, no hierarchy, everything competing.

---

### Landing Pages & Conversion Flows

| Priority        | Law                        | Why                                                |
| --------------- | -------------------------- | -------------------------------------------------- |
| 🔴 Critical     | Von Restorff Effect        | CTA pops; one standout per screen                  |
| 🔴 Critical     | Jakob's Law                | Conventional patterns reduce friction              |
| 🟡 Important    | Aesthetic-Usability Effect | First impression ~50ms; polish = perceived quality |
| 🟡 Important    | Peak-End Rule              | Strong finish to conversion flow                   |
| 🟡 Important    | Cognitive Bias (ethical)   | Anchoring, social proof, smart defaults            |
| 🔵 Nice-to-have | Hick's Law                 | Remove nav clutter on landing pages                |
| 🔵 Nice-to-have | Choice Overload            | 1-3 CTAs, not 8                                    |

**Common anti-pattern:** 5 equally-weighted buttons, generic feel, no clear next step, weak end-state.

---

### Mobile & Touch Interfaces

| Priority        | Law                 | Why                                                  |
| --------------- | ------------------- | ---------------------------------------------------- |
| 🔴 Critical     | Fitts's Law         | Thumb zones; 44px min targets; edge placement        |
| 🔴 Critical     | Doherty Threshold   | Touch feedback < 100ms; optimistic actions           |
| 🔴 Critical     | Hick's Law          | Progressive disclosure is mandatory on small screens |
| 🟡 Important    | Cognitive Load      | Every pixel must earn its place                      |
| 🟡 Important    | Law of Proximity    | Touch targets must not be accidentally adjacent      |
| 🟡 Important    | Zeigarnik Effect    | Progress visible; multi-step shows %                 |
| 🔵 Nice-to-have | Aesthetic-Usability | Touch = intimate; polish matters more                |
| 🔵 Nice-to-have | Flow                | Minimize interruptions; fullscreen focus modes       |

**Common anti-pattern:** Tiny tap targets crammed together, no touch feedback, desktop squished onto phone.

---

### Navigation & Information Architecture

| Priority        | Law                    | Why                                           |
| --------------- | ---------------------- | --------------------------------------------- |
| 🔴 Critical     | Jakob's Law            | Conventional patterns; users know nav already |
| 🔴 Critical     | Hick's Law             | 5–7 top-level items max; group rest           |
| 🟡 Important    | Mental Model           | Match user's mental map of where things live  |
| 🟡 Important    | Serial Position Effect | Most-used first; account/profile last         |
| 🔵 Nice-to-have | Uniform Connectedness  | Breadcrumbs, step indicators show sequence    |
| 🔵 Nice-to-have | Selective Attention    | Current page clearly distinguished            |

**Common anti-pattern:** 15+ top-level items, non-standard icons without labels, inconsistent hierarchy.

---

## Quick Reference: All 30 Laws

| #   | Law                              | One-Line Summary                                                   |
| --- | -------------------------------- | ------------------------------------------------------------------ |
| 1   | **Fitts's Law**                  | Target time = f(distance, size). Make buttons big and close.       |
| 2   | **Doherty Threshold**            | Respond < 400ms. Optimistic UI, instant feedback.                  |
| 3   | **Hick's Law**                   | More choices = slower decisions. Progressive disclosure.           |
| 4   | **Jakob's Law**                  | Users know other sites better than yours. Use conventions.         |
| 5   | **Mental Model**                 | Design for how users THINK it works, not just how it does.         |
| 6   | **Paradox of Active User**       | Nobody reads docs. Make it work immediately.                       |
| 7   | **Law of Proximity**             | Near items = related. Spacing creates groups.                      |
| 8   | **Law of Similarity**            | Same look = same kind. Visual consistency = relationship signal.   |
| 9   | **Law of Common Region**         | Shared boundary = shared group. Cards, panels, containers.         |
| 10  | **Law of Uniform Connectedness** | Connected elements = related. Lines, breadcrumbs, borders.         |
| 11  | **Law of Prägnanz**              | Complex → interpreted as simplest form. Reduce noise.              |
| 12  | **Von Restorff Effect**          | Odd one out remembered best. One standout per screen.              |
| 13  | **Selective Attention**          | Ignore off-goal content. Design for current task.                  |
| 14  | **Miller's Law**                 | Working memory holds 7±2 items. Limit options per view.            |
| 15  | **Cognitive Load**               | Mental effort to understand UI. Kill extraneous load.              |
| 16  | **Chunking**                     | Break info into meaningful groups. Headings, cards, sections.      |
| 17  | **Working Memory**               | Temporary task memory. Show state; persist drafts.                 |
| 18  | **Serial Position Effect**       | First and last remembered best. Edges matter.                      |
| 19  | **Aesthetic-Usability Effect**   | Pretty = feels usable. Polish is functional.                       |
| 20  | **Peak-End Rule**                | Judged by peak emotion + final moment. Design both.                |
| 21  | **Zeigarnik Effect**             | Incomplete tasks remembered better. Show progress.                 |
| 22  | **Goal-Gradient Effect**         | Closer to goal = more motivated. Accelerate near end.              |
| 23  | **Flow**                         | Immersed focus. Match challenge to skill; remove friction.         |
| 24  | **Cognitive Bias**               | Systematic thinking errors. Design ethically; avoid dark patterns. |
| 25  | **Choice Overload**              | Too many options = paralysis. Curate; recommend default.           |
| 26  | **Tesler's Law**                 | Complexity can't die, only move. Absorb in code, not UI.           |
| 27  | **Postel's Law**                 | Liberal in what you accept, conservative in what you send.         |
| 28  | **Occam's Razor**                | Simplest solution wins. Fewest assumptions.                        |
| 29  | **Parkinson's Law**              | Work expands to fill time. Design for speed.                       |

> _Note: Working Memory (#17) and Miller's Law (#14) are closely related. Chunking (#16) is the primary technique for both._

---

## The Laws (Detailed Reference)

> **Read on-demand** after selecting relevant laws from context routing or Quick Reference. Don't present all at once.

---

## 1. Fitts's Law

> _Target acquisition time = f(distance, size)._

**Rules:** Targets ≥ **44×44px** (iOS) / **48×48px** (Material). Never < 32px. Place primaries in easy-reach areas (top-left, center, screen edges — edges are effectively infinite). Destructive actions far from frequent ones (leverage Fitts's as safety).

**Mobile thumb zones:** Bottom-left/right = natural grip (green zone). Top-center = hardest reach (red zone). Put primary actions green, destructive red.

```css
/* ✅ */
.btn {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 24px;
  margin: 8px;
}
/* ❌ */
.tiny {
  height: 20px;
  padding: 2px 6px;
  margin: 2px;
}
```

**Anti-patterns:** Close buttons < 16px, dense icon toolbars without labels, dropdowns with tiny hit areas.

**Validate:** Track misclick rate on small targets. Heatmap tap density. If > 3% of taps miss, enlarge.

---

## 2. Doherty Threshold

> _Respond < 400ms or lose attention._

**Rules:** Visual feedback < 100ms (hover, press, focus). **Optimistic UI** — don't block on server for local actions (toggles, likes, checkboxes). Show progress for anything > 1s (spinners, skeletons, bars).

**Perceived performance tricks:** Skeletons > spinners. Animated progress bars feel faster even if indeterminate. Staggered reveal holds attention. Micro-delays after payment increase perceived value ("something important happened").

```tsx
// ✅ Instant visual, async sync
const handleLike = () => {
  setLiked(!liked); // < 100ms
  mutateToggleLike(id).catch(() => setLiked(!liked)); // async
};
// ❌ Blocking await — user stares at nothing
await api.toggleLike(id);
setLiked(!liked);
```

**Anti-patterns:** Unresponsive during fetches, blank route transitions, no loading states.

**Validate:** Time-to-interactive. Lighthouse "First Input Delay." User studies: watch for repeated clicks (sign of "did it register?").

---

## 3. Hick's Law

> _More choices = slower decisions._

**Rules:** **Progressively disclose** — show only what's needed now. Wizards, accordions, "Advanced ▾". **Highlight default** — guide don't overwhelm. **Break forms into steps** — 20 fields → 3 steps of ~7. **Nav: ~5–7 items** top level.

```tsx
// ✅ Progressive disclosure
<Section title="Basic" defaultOpen><Toggle label="Notifications" /></Section>
<Collapsible title="Advanced"><Select label="Cache strategy" /></Collapsible>
// ❌ Wall of choices — 25 fields at once
```

**Anti-patterns:** 15+ nav items, every metric visible, 50-option selects, pricing with no recommended plan.

**Validate:** Form completion time (before/after splitting steps). Drop-off rate per added option. Heatmap dwell time on decision points.

---

## 4. Jakob's Law

> _Users spend most time on other sites. Yours should work like them._

**Rules:** Logo → home (top-left), cart → top-right, search → 🔍, mobile → hamburger, hierarchy → breadcrumbs. Don't reinvent date pickers, modals, dropdowns, tabs unless you have overwhelming reason. When innovating, provide off-ramp (YouTube redesign approach).

**The innovation tradeoff:** Novel patterns incur training debt. Ask: _Does this give enough value to justify learning cost?_

**Anti-patterns:** Custom scroll behavior, repositioned submit button, novel navigation without signifiers.

**Validate:** Task completion time for first-time users vs returning users. If first-time is dramatically slower, Jakob's debt may be too high. Onboarding drop-off rate.

---

## 5. Mental Model

> _Design for how users THINK it works._

**Rules:** Leverage existing models ("like Spotify" → Spotify metaphors). Bridge gaps with analogies. Expose cause-and-effect visibly. Avoid hidden modes (double-click ≠ single-click in same context).

**Detect broken models:** Users hesitate, hover aimlessly, click wrong thing repeatedly, say "I thought it would..."

**Anti-patterns:** Hidden features, inconsistent behaviors across similar elements, abstract icons without labels.

**Validate:** Think-aloud protocols. Watch for surprise ("I didn't expect that to happen"). Error patterns that suggest wrong mental model.

---

## 6. Paradox of the Active User

> _Nobody reads docs. They start clicking immediately._

**Rules:** **Zero-onboarding usage possible.** Defaults work well. Core value accessible without tutorial. **Contextual help > documentation.** Tooltips, inline hints, microcopy beat PDFs. **Design error recovery.** Undo, clear next steps, forgiving inputs. **Learning by doing.** Tours interact with real UI, progressive feature reveal.

**The 10-second test:** Can a new user accomplish something meaningful within 10 seconds? If not, most bounce before finding help.

**Anti-patterns:** Mandatory 10-step onboarding before access, features locked behind docs, errors referencing manual page numbers.

**Validate:** Time-to-first-value. Onboarding completion rate (if mandatory). Support ticket frequency for "how do I..." questions that should be discoverable.

---

## 7. Law of Proximity

> _Near items = related items._

**Rules:** Group with whitespace, not lines. Label closer to its input than next field's label. Consistent spacing scale (base 4px: `4, 8, 12, 16, 24, 32, 48, 64`). Within-group gap < between-group gap.

```css
/* ✅ Proximity creates groups */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 24px;
}
/* ❌ Uniform spacing = no grouping */
.form-bad > * + * {
  margin-top: 16px;
}
```

**Where it applies:** Form labels, card titles, toolbar icon groups, list items, definition lists. Bring related things closer, push unrelated apart.

---

## 8. Law of Similarity

> _Same look = same kind._

**Rules:** Same style = same type. All primary buttons match. All destructive = red. All links share color/underline. Different actions MUST look different. Cancel ≠ Submit visually.

```css
/* ✅ Visual language = function */
.primary {
  background: #0066cc;
  color: white;
  font-weight: 600;
}
.secondary {
  background: #f0f0f0;
  color: #333;
}
.danger {
  background: #dc3545;
  color: white;
}
/* ❌ Same look, different function = confusion */
.submit {
  background: #0066cc;
}
.cancel {
  background: #0066cc;
}
```

**Pro tip:** Audit in **grayscale**. Can't distinguish action types by size/shape/weight alone? Over-relying on color = accessibility issue.

---

## 9. Law of Common Region

> _Shared boundary = shared group._

**Rules:** Cards, panels, containers = regions (background, border, shadow). Sidebar/main/header = regions via contrast. Wizard steps as cards = clear stage boundaries.

**Hierarchy:** Common Region > Proximity. Items in same card grouped even if spaced within it. Items in different cards seen as separate even if close.

```html
<!-- Regions group by boundary -->
<div class="grid grid-cols-3 gap-6">
  <div class="card col-span-2"><h3>Analytics</h3></div>
  <!-- region A -->
  <div class="card"><h3>Quick Actions</h3></div>
  <!-- region B -->
</div>
```

---

## 10. Law of Uniform Connectedness

> _Connected elements = related._

**Rules:** Connector lines beat proximity. Timelines, workflows, step indicators — lines show sequence. Breadcrumb separators, table row borders exploit this.

**Gestalt strength:** Uniform Connectedness > Common Region > Similarity > Proximity. **When in doubt, draw a line.**

```html
<!-- Step indicator uses connection -->
<div class="steps">──●──●──○</div>
<!-- List border connects items -->
<ul class="connected-list">
  <li>A</li>
  <li>B</li>
  <li>C</li>
</ul>
```

---

## 11. Law of Prägnanz (Simplicity)

> _Complex → interpreted as simplest form._

**Rules:** Every element earns its place ("Does this help the user NOW?"). Recognizable icons only (trash can = trash can). Standard layouts (single-col reading, grid browsing, sidebar+main tools). Decorative complexity without function = cognitive tax.

**Simplicity test:** Describe page structure in **one sentence**: "It's a [layout] with [main] and [secondary]." Need five sentences? Too much going on.

---

## 12. Von Restorff Effect (Isolation Effect)

> _Odd one out remembered best._

**Rules:** **One standout per screen max.** Primary CTA visually distinct from secondary/cancel. Important notifications break pattern. **Restraint = skill.** Pick 1-2 emphasis dimensions (size, weight, color, position, motion). Not all everywhere.

```css
/* ✅ One pops */
.secondary {
  background: #f0f0f0;
}
.primary {
  background: #0066cc;
  color: white;
  font-weight: 600;
} /* pops */
.danger {
  background: #dc3545;
  color: white;
} /* sparse */
/* ❌ Everything competes */
.a {
  background: red;
}
.b {
  background: blue;
  font-size: 1.2em;
}
.c {
  background: yellow;
  animation: pulse;
}
```

**⚠️ Accessibility:** Never rely on color alone. Combine size + weight + shape + position + text. Respect `prefers-reduced-motion`.

**⚠️ Ad-blindness risk:** Standout element that looks like banner ad (flashing, aggressive contrast, ad placement) → users tune out via Selective Attention. Emphasis must feel native.

---

## 13. Selective Attention

> _People focus only on goal-related stimuli._

**Rules:** Ignore off-goal content (checkout user misses newsletter banner). Design for goal-state RIGHT NOW. Avoid banner-blindness zones (top-right banners, ad-like footers). In-context beats prominent (inline message where user looks > interrupting modal).

**Goal-State Mapping technique:**

```
Goal: "Find pricing"
→ Pricing link obvious in nav + footer + homepage
→ No "Read our blog" popup on pricing page
→ Nav clutter removed on pricing page (Hick's + Selective Attention combo)

Goal: "Submit this form"
→ Header/nav/footer/sidebar stripped — pure form view
→ Progress indicator shown (Working Memory)
→ One clear CTA (Von Restorff)
→ Inline validation, fast (Doherty + Postel's)
```

**Anti-pattern:** Promo banners on checkout, modals interrupting tasks, critical info in footers on task pages.

---

## 14. Miller's Law

> _Working memory holds 7±2 items._

**Rules:** ~5–9 items per view (nav tabs, filters, radios). Chunk to stay within limit. Never require cross-page recall. **Practical limit: 4±1** for complex items (menu options with labels) — original paper was 1D stimuli; real items are richer. Err toward fewer.

**Validate:** Card sorting studies. Eye-tracking (fixation count per area). Task success when N items present vs reduced.

---

## 15. Cognitive Load

> _Mental resources needed to understand your UI._

Three types — know which you're designing for:

| Type           | Definition                       | Fix                                                                          |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| **Intrinsic**  | Effort inherent to the task      | Support with wizards, previews, tooltips. Can't eliminate, only support.     |
| **Extraneous** | Effort from HOW you present it   | **Fixable.** Remove decoration, simplify visuals, kill gratuitous animation. |
| **Germane**    | Effort spent learning/processing | Reduce via familiarity (Jakob's). Known patterns = zero learning cost.       |

**Golden rule: One concept per screen.** Settings categorized, not 50 toggles flat.

**Validate:** NASA-TLX task load assessment (research method). Time-on-task comparisons. Error rate correlation with interface complexity.

---

## 16. Chunking

> _Break info into meaningful groups._

**Rules:** Group nav under headings ("Account", "Billing"). Format data for scanning (phones, dates, addresses). Card grids chunk content (12 posts → 3×4 cards). Breadcrumbs = spatial chunks.

**Chunking vs Progressive Disclosure:** Chunking organizes WHAT'S VISIBLE. PD controls HOW MUCH IS VISIBLE. They work together — show few chunks, expand within each.

**Practical sizes:** Nav group: 3-7. Form step: 4-7 fields. Dashboard row: 2-4 cards. Table cols: 4-8 visible. List before paginate: 7-15.

---

## 17. Working Memory

> _Temporary memory for active tasks._

**Rules:** Never ask users to recall from previous step without showing it ("Step 3 of 3" summarizes 1&2). Persist values (navigate away/back → draft still there). State visibility always (saving? saved? what's left?). Multi-step = persistent progress indicator.

**Micro-friction cost:** Every forgotten piece = tiny frustration. Accumulates → abandonment.

**Implementation checklist:** Auto-save drafts ✓. Summarize prior selections ✓. Save status visible ✓. Restore state on return ✓.

**Validate:** Return rate after abandonment (did draft-saving bring them back?). Error rate on multi-step flows (does state visibility reduce mistakes?). "Start over" click rate.

---

## 18. Serial Position Effect

> _First and last remembered best._

**Rules:** Most important item first, most important action last. Nav: most-used first. Form: primary CTA last. Pricing: recommended plan first or last (or Von Restorff-highlighted). Accept middle amnesia in equal lists.

**Beyond lists:** Menu: revenue links first. Announcements: lead with biggest win. Errors: most actionable first (not necessarily first from backend). Testimonials: strongest quote first or last.

---

## 19. Aesthetic-Usability Effect

> _Pretty = feels more usable._

**Rules:** Polish is functional, not cosmetic. Cohesive design system (type, color, spacing, icons). ⚠️ Beauty masks problems — test function separately from form. First impression: **~50ms**. Above-the-fold sets tone for everything.

**Polish checklist:** Consistent type scale ✓. Harmonious colors ✓. Whitespace ✓. Single icon family ✓. Micro-interactions ✓. Responsive everywhere ✓. No ragged edges/misalignments ✓.

**Stakeholder pitch:** "Investing in visual quality isn't vanity — the Aesthetic-Usability Effect is well-documented. Users report higher satisfaction and tolerance in polished interfaces. It's a usability multiplier."

**Validate:** A/B test: same functionality, different polish levels. Perceived usability ratings (expect pretty version to score higher even if functionally identical). Task completion rates (the real test — sometimes pretty version wins, sometimes it masks problems).

---

## 20. Peak-End Rule

> _Judged by peak emotion + final moment._

**Rules:** Design peak moments at task completion (confetti, copy, animation). End every flow on high note (warm confirmation + next steps). **Negative peaks linger longer** — invest in error recovery. Map journey → identify peaks → design intentionally.

**Flow endings ranked:**

1. ✅ Delight + clear next step (confetti + "View order")
2. ✅ Warm confirmation + next step
3. ⚠️ Confirmation only ("Done") — functional, forgettable
4. ❌ Abrupt cutoff — feels broken
5. ❌ Negative peak at end — worst impression

```tsx
// ✅ Strong end
<SuccessScreen>
  <Confetti />
  <Heading>Order #{id} confirmed!</Heading>
  <p>Email sent to {email} with tracking.</p>
  <CTA href="/orders">View Details</CTA>
</SuccessScreen>
// ❌ Dead end
<div>Thank you. Order received.</div>
```

**Validate:** NPS/CSAT measured at flow endpoints (Peak-End prediction: these scores weight heavily on final moment). Exit survey after key flows. Return rate post-completion (did good ending bring them back?).

---

## 21. Zeigarnik Effect

> _Incomplete tasks remembered better._

**Rules:** Show incomplete progress prominently ("75% complete", "3 of 8 remaining"). Partial progress motivates (endowed progress: signup instant 10%). Auto-save drafts → incomplete = return motivation. Never hide in-progress state (drafts, abandoned carts, unfinished onboarding = re-entry points).

```tsx
<Card>
  <ProgressBar value={percent} />
  <p>{percent}% complete</p>
  {percent < 100 && <Link to="/settings/profile">Complete →</Link>}
</Card>
```

**⚠️ Ethics:** Powerful but can manipulate (gamification dark patterns, artificial urgency). Use for genuinely valuable tasks, not addictive looping.

**Validate:** Return/abandonment rate after showing progress bar (before/after). Profile completion rate with vs without endowed progress. Draft recovery rate (auto-saved drafts reopened within 7 days).

---

## 22. Goal-Gradient Effect

> _Closer to goal = more motivated._

**Rules:** Accelerate perceived progress near end (smaller remaining steps, larger increments). Framing: "Only 2 purchases until Gold!" >> "10 to reach Gold." Large goals → milestones. Onboarding bars filling faster near end = higher finish rates.

**Techniques:** Non-linear easing progress bar (accelerates toward 100%). Milestone celebrations at 25/50/75%. "Almost there!" when >80%. Remaining count near goal ("2 steps left" > "92%").

**Validate:** Funnel progression velocity (do users speed up near end?). Milestone engagement rate (do 25/50/75% markers increase activity?). A/B: linear vs accelerated progress bar.

---

## 23. Flow

> _Immersed focus state._

**Rules:** Match challenge to skill (novices → guided, experts → shortcuts/bulk). Remove friction from core tasks (writing app → distraction-free, IDE → seamless code/run/debug). Immediate feedback loops (Doherty). Don't interrupt flow with modals/upsells during focus tasks.

**Broken flow signs:** User stops to think "where next?", waits, switches context, gets pulled away. Each break risks losing flow — takes **15-25 minutes** to regain deep flow.

**Flow-friendly patterns:** Keyboard shortcuts. Command palette (`Cmd+K`). Auto-save. Distraction-free/fullscreen mode. Batch operations (select many → act once).

**Validate:** Session duration for focus tasks (longer = more flow). Interruption recovery time. Power-user feature adoption rate. Keyboard shortcut usage analytics.

---

## 24. Cognitive Bias

> _Systematic thinking errors._

**Ethical persuasion toolkit:**

- **Anchoring:** Original price crossed out next to sale
- **Social proof:** "10,000+ developers" (must be genuine)
- **Scarcity (genuine only):** "3 spots left"
- **Defaults:** Pre-select recommended option
- **Authority:** "Recommended by [trusted expert]"

**Dark patterns to never use:** Fake scarcity. Forced continuity (auto-bill without warning). Confirmshaming ("No, I want to miss out"). Roach motel (easy join, impossible leave). Hidden costs at checkout.

**Trust equation:** Short-term dark pattern gains << Long-term trust value. Every deceptive manipulation erodes future trust.

**Validate:** Conversion rates with ethical vs dark patterns (dark usually wins short-term, loses long-term). Churn rate post-signup (did manipulative signup backfire?). Support ticket sentiment analysis.

---

## 25. Choice Overload (Paradox of Choice)

> _Too many options = paralysis._

**Rules:** Curate 3-5 options. "See all" for power users. Smart recommendations / "Pick for me." Categorized choice architecture (50 in 5 categories of 10 >> 50 flat). Defer complex decisions (favorite, compare, "decide later").

**Sweet spot:** Research shows **3-5 options** maximizes satisfaction. <3 feels constraining. >7 causes measurable fatigue. 3-5 with recommended default = optimal.

**Many-options fallback:** Default pre-selected → filters to narrow → comparison mode → "decide later" with save.

**Validate:** Decision completion rate vs number of options presented (graph it — expect inverted-U curve). Time-to-decision. "Skip" / abandon rate at selection screens.

---

## 26. Tesler's Law (Conservation of Complexity)

> _Complexity can't die. Only move — code or user's brain._

**Rules:** Absorb complexity in code, not UI. Smart defaults (10 settings? Pick good ones, let users override). Don't oversimplify to abstraction ("Auto" that doesn't work well >> thoughtful controls). Simple surface, advanced underneath. **Progressive disclosure = answer.**

```tsx
// ✅ System absorbs complexity
<SmartDateInput label="When?" /* parses, timezone, validates, formats */ />
// ❌ Complexity dumped on user
<input placeholder="2024-01-15T14:30:00+00:00" label="Enter ISO 8601 with timezone..." />
```

**Engineer's tradeoff:** 1 extra week reducing UI complexity saves millions × 1 minute each. Always absorb in code.

**Signs complexity is misplaced:** Users need docs for basic features. Errors expose internals (UUIDs, stack traces). "Why is this so complicated?" about common tasks.

**Validate:** Time-to-task-completion before/after simplification. Support ticket complexity ("how do I..."). Feature discovery rate (are advanced features being used or ignored?).

---

## 27. Postel's Law (Robustness Principle)

> _Liberal in what you accept, conservative in what you send._

**Rules:** Accept varied input gracefully — phones `(555) 123-4567` / `555.123.4567` / `5551234567`, names with unicode/spaces/hyphens, dates in any format, search with typos/fuzzy match. Output clean normalized data. Forgive errors ("Did you mean...?" > "Invalid."). Graceful degradation.

```tsx
// ✅ Liberal input, conservative output
<input
  onChange={(e) => {
    const raw = e.target.value.replace(/[^\d+\-\s().]/g, "");
    onChange(raw); // normalize internally
  }}
  placeholder="(555) 123-4567"
/>
// Output: phone.replace(/\D/g, '') → "+1 (555) 123-4567" → "15551234567"
```

**Foundation of forgiving UX.** Combine with Doherty (fast validation) + Active User (no manual needed) = forms that feel intelligent, not rigid.

**Validate:** Form error rate by input format diversity. Support tickets for "it won't accept my [valid] input." Completion rate with forgiving vs strict validation.

---

## 28. Occam's Razor

> _Simplest solution with fewest assumptions wins._

**Rules:** Simplest explanation for behavior is usually right (button not clicked? Doesn't look clickable / poorly positioned / unclear label — NOT "users don't understand our paradigm"). Fewer moving parts wins. Not every screen needs A/B testing, animation, or real-time validation.

**Occam's questions before adding anything:**

1. Does this solve a real observed problem?
2. Is there a simpler way?
3. Does this add a new user concept?
4. Would removing it break anything?
5. Can we ship without it and add later?

**The trap:** "Simplest" ≠ "oversimplified to useless." Simplest that **actually solves the problem**. Under-simplifying = Tesler's violation (complexity pushed to user).

**Validate:** Feature usage rate (is the complex version actually used?). Support tickets for confused users. A/B: simple vs full-featured version.

---

## 29. Parkinson's Law

> _Work expands to fill available time._

**Rules:** Design for speed (auto-save, shortcuts, templates, bulk ops). Implicit deadlines (progress bars, "Step 2 of 4", ETA). Remove unnecessary steps. Pre-fill everything possible.

**Parkinson's manifests as:** Forms: could be 3 fields but are 10 (space existed). Onboarding: 5 minutes because nobody constrained it. Checkout: 6 steps (each team added "just one more"). Settings: grew organically without pruning.

**Counter-tactics:** Arbitrary constraints at design time ("fits one screen," "checkout ≤ 3 steps"). Time yourself (you built it = 2min → user takes 10+). Measure drop-off per step (abandonment = bloat signal).

**Validate:** Time-on-task measurements. Step-by-step funnel drop-off (which step loses most users?). Form completion time with vs without pre-fill. Before/after constraint-imposed redesign.

---

## Combined Application: How Laws Work Together

Real design never applies one law in isolation. Here's how they combine on common components:

### A Well-Designed Card Component

```
┌─────────────────────────────────┐  ← Common Region (boundary groups content)
│ 📊 Revenue        $12,400      │  ← Similarity (icon + label + value pattern)
│                         ↑ +8%   │  ← Von Restorff (trend badge pops — ONE emphasis)
│                                 │
│ ─────── ─────── ───────       │  ← Uniform Connectedness (lines = related)
│ Jan    Feb    Mar            │     sub-items
└─────────────────────────────────┘  ← Prägnanz (simple layout, scannable)
     ↑                           ← Proximity (title close to chart, far from next card)
```

Laws applied: **Common Region + Similarity + Von Restorff + Uniform Connectedness + Prägnanz + Proximity** = 6 laws on one component. This is normal.

### A Multi-Step Signup Form

```
Step 1: Create Account    ●━━━━●━━━━○━━━━○   ← Uniform Connectedness (progress)
                        ↑                ← Doherty (inline validation < 400ms)
  Email: [____________]                  ← Postel's (accepts any email format)
  Password: [__________]                 ← Tesler's (password strength meter;
                                         shows requirements inline)

Step 2: Your Profile                     ← Hick's (only 3 fields — not 10)
  Name: [_____________]                 ← Fitts's (44px inputs, spaced 8px apart)
  Avatar: [Upload]                      ← Von Restorff (primary "Upload" button pops)

Step 3: Preferences  (collapsed ▾)      ← Progressive disclosure (Hick's again)
  [✓] Email updates                    ← Default pre-selected (Cognitive Bias)
  [  ] SMS notifications               ← Zeigarnik (overall progress: 66%)
                                       ← Working Memory (steps 1-2 summarized here)
```

Laws applied: **9 laws working together** across 3 steps. This is what real design looks like.

### A Dashboard Page

```
┌─ Navigation ──────────────┐  ← Jakob's (conventional left-nav)
│ Home  Analytics  Settings  │     Hick's (5 items, grouped)
│                            │
├──────────────┬─────────────┤  ← Proximity (two regions, loosely spaced)
│             │             │
│  ANALYTICS  │  QUICK ACTS  │  ← Common Region (cards = regions)
│  ┌─────┐    │  ┌─────┐    │
│  │ Rev │    │  │ +Add│    │  ← Similarity (same card structure)
│  │Users│    │  │Export│   │
│  └─────┘    │  └─────┘    │
│  ┌─────┐    │             │
│  │Bounce│   │             │  ← Von Restorff (alert card pops if error)
│  └─────┘    │             │
└──────────────┴─────────────┘  ← Prägnanz (whole thing describable in one sentence)
   ↑ Cognitive Load: one concept per region
   ↑ Selective Attention: highest metrics in scan path (top-left of main)
   ↑ Serial Position: most important metric first (Revenue)
```

**Takeaway:** Don't try to apply laws one-at-a-time. Design the component, then audit against relevant laws to find gaps.

---

## Real-World Teardowns

### Teardown 1: GitHub Settings Page (Before → After)

**Before (typical SaaS anti-pattern):**

- 50+ toggles in a flat alphabetical list
- No grouping, no search, no indication of which settings matter
- "Advanced" toggle mixed with basic preferences
- Each toggle identical visual weight
- No way to understand impact of changing a setting

**Laws violated:** Cognitive Load (🔴), Hick's Law (🔴), Chunking (🔁), Von Restorff (none — nothing stands out), Miller's Law (🔴), Tesler's Law (complexity dumped on user)

**After (applying laws):**

- **Chunked into 4 categories:** Account, Notifications, Integrations, Advanced (Chunking + Cognitive Load)
- **Search bar at top** (Postel's — accepts fuzzy queries)
- **Each category collapsed by default** (Hick's — progressive disclosure)
- **"Danger Zone" for destructive actions in separate red-bordered card** (Von Restorff + Common Region + Fitts's — dangerous actions far from frequent ones)
- **Most-common settings have smart defaults pre-selected** (Tesler's + Cognitive Bias)
- **"Reset to defaults" button at bottom** (Paradox of Active User — recovery from bad changes)

**Result:** Settings went from overwhelming to navigable in one redesign pass.

---

### Teardown 2: Typical SaaS Pricing Page (Before → After)

**Before:**

- 3 pricing tiers in identically styled cards
- No recommendation (user must figure out which plan)
- All features listed for all plans (decision fatigue)
- CTA buttons identical weight/color
- No urgency or social proof

**Laws violated:** Von Restorff (🔴 — no standout), Choice Overload (🔴), Hick's Law (🔴), Cognitive Bias (missing — no anchoring/social proof/defaults), Peak-End Rule (weak end state)

**After:**

- **Middle plan (recommended) has highlighted border + "Most Popular" badge** (Von Restorff — one pops)
- **Left plan crossed-out original price next to current** (Cognitive Bias — anchoring)
- **"Basic / Pro / Enterprise" → "For individuals / For teams / For companies"** (chunking by user type, not feature count)
- **Only 3-5 differences between plans shown** (others collapsed under "Everything in Basic plus...") (Hick's — reduced comparison scope)
- **Primary CTA larger + colored, secondary "Contact Sales" muted** (Von Restorff + Fitts's)
- **"Join 10,000+ teams" below CTA** (Social proof — genuine)
- **After clicking CTA: warm confirmation with setup timeline** (Peak-End Rule)

**Result:** Conversion typically increases 15-30% with these changes (based on aggregated case studies from nngroup.com, conversionciencia.com).

---

### Teardown 3: E-commerce Checkout Flow (Before → After)

**Before:**

- All 15 fields on one page
- Strict date/phone formatting (errors if user types "naturally")
- No progress indicator
- Generic "Order confirmed" text at end
- Error messages: "Invalid input" (no guidance)
- Loading spinner on submit, no feedback during wait

**Laws violated:** Postel's (🔴), Hick's (🔴), Doherty (🔴), Working Memory (🟡), Peak-End Rule (🔴), Fitts's (🟡)

**After:**

- **3 steps:** Cart → Shipping/Payment → Confirm (Hick's + Miller's)
- **Phone field accepts any format, displays formatted** (Postel's)
- **Inline validation on blur** (Doherty < 400ms)
- **Optimistic "Processing..." with confetti animation** (Doherty perceived perf + Peak-End delight)
- **"Step 2 of 3" header summarizes cart contents** (Working Memory)
- **Large 44px touch targets throughout** (Fitts's)
- **Final screen: order summary + tracking link + "You might also like"** (Peak-End strong finish + Goal-Gradient)

**Result:** Cart abandonment typically drops 20-35% with optimized checkout flows (Baymard Institute benchmark data).

---

## When Laws Conflict

### Fitts's vs Von Restorff

**Tension:** Everything big (Fitts's) vs one thing pops (Von Restorff)
**Resolution:** All elements meet **44px minimum** (Fitts's floor). Use **weight/color/position** for primary CTA only (Von Restorff ceiling). Every button reachable; only one demands attention.

### Hick's vs Postel's

**Tension:** Limit choices (Hick's) vs accept any input (Postel's)
**Resolution:** Present **few focused options** in UI (dropdown, presets) but accept **flexible text input** as fallback. Date picker shows calendar (few choices) + accepts typed dates in any format (liberal input).

### Jakob's vs Innovation

**Tension:** Conventional (Jakob's) vs differentiate
**Resolution:** **Conventional in interaction** (works as expected) + **distinctive in personality** (visual brand, voice, micro-interactions). Innovation reserved for where convention is genuinely broken.

### Aesthetic-Usability vs Peak-End

**Tension:** Polish everywhere (AE) vs peaks/ends only (Peak-End)
**Resolution:** AE sets **baseline quality** (every screen meets bar). Peak-End identifies **2-3 moments** for extra investment (onboarding complete, first success, checkout confirm). Budget: **80% consistent quality, 20% peak delight.**

### Tesler's vs Occam's

**Tension:** Absorb complexity (Tesler's) vs keep simple (Occam's)
**Resolution:** Allies, not enemies. **Occam's = WHAT to build** (simplest solution that works). **Tesler's = WHERE complexity lives** (code, not UI). Simple UI often needs sophisticated code (smart defaults, fuzzy parsing).

### Von Restorff vs Accessibility

**Tension:** Stand out (Von Restorff) vs don't rely on color (a11y)
**Resolution:** **Multi-dimensional emphasis.** Size + weight + position + color (not color alone). Primary button bigger, bolder, positioned prominently, AND colored differently. Win-win.

### Cognitive Bias vs Trust

**Tension:** Guide choices (Bias) vs don't manipulate (Trust)
**Resolution:** Line = **transparency.** Anchoring/social proof/defaults ethical when: claims **genuine**, user **benefits**, can **opt out easily**. Unethical when: fabricated claims, self-serving guidance, hidden opt-out.

---

## Review Workflow

Run this protocol when reviewing any UI. **Output: prioritized findings list.**

### Phase 1: Gather

1. **Screenshot/screen** the interface being reviewed
2. **Identify user's goal-state** (what are they trying to accomplish here?)
3. **Note the context** (desktop/mobile? first-time user? power user? stressed/rushed?)

### Phase 2: Critical Checks (🔴 stop if failing)

| #   | Check                                      | Law                    | Fail =                            |
| --- | ------------------------------------------ | ---------------------- | --------------------------------- |
| C1  | Touch/click targets ≥ 44×44px?             | Fitts's                | Misclicks, mobile frustration     |
| C2  | Visual feedback < 400ms on interactions?   | Doherty                | Feels broken/unresponsive         |
| C3  | Input accepts varied formats gracefully?   | Postel's               | Frustrated users, support tickets |
| C4  | Errors recoverable with clear next steps?  | Postel's + Active User | Abandonment at failure            |
| C5  | Uses conventional patterns for core tasks? | Jakob's                | Confusion, learning friction      |

### Phase 3: Important Checks (🟡 note improvements)

| #   | Check                                                       | Law                       |
| --- | ----------------------------------------------------------- | ------------------------- |
| I1  | ≤ 5–7 choices per view?                                     | Miller's + Hick's         |
| I2  | Progressive disclosure for complex features?                | Hick's + Tesler's         |
| I3  | Related items grouped (proximity)? Scattered = hard to scan | Proximity                 |
| I4  | Clear container boundaries (regions)?                       | Common Region             |
| I5  | One primary emphasis per screen?                            | Von Restorff              |
| I6  | Information chunked/scannable?                              | Chunking + Cognitive Load |
| I7  | Cross-step state visible? Drafts persisted?                 | Working Memory            |
| I8  | Smart defaults selected?                                    | Tesler's + Cognitive Bias |

### Phase 4: Enhancement Checks (🔵 note as polish)

| #   | Check                                  | Law                 |
| --- | -------------------------------------- | ------------------- |
| E1  | Delight moment at task completion?     | Peak-End            |
| E2  | Incomplete progress visible?           | Zeigarnik           |
| E3  | Strong finish to flow?                 | Peak-End            |
| E4  | Polished, coherent visual design?      | Aesthetic-Usability |
| E5  | Important items at list edges?         | Serial Position     |
| E6  | Off-goal content minimized?            | Selective Attention |
| E7  | Keyboard shortcuts / power-user paths? | Flow                |

### Phase 5: Output

```
## UX Review: [Screen/Page Name]

### 🔴 Critical Findings (fix first)
1. [Law] What's wrong → Specific fix → Severity rationale

### 🟡 Improvements
1. [Law] What could be better → Suggested change

### 🔵 Enhancements
1. [Law] Delight opportunity → Suggestion
```

---

## Stakeholder Communication

Scripts for pushing back, adapted by audience.

### Evidence-Based (for PMs, tech leads, data-driven teams)

**"Add more options/features":**

> "This screen presents N options. Hick's Law shows decision time grows logarithmically with choices — we're slowing users down with every addition. Recommend: (a) progressive disclosure under Advanced, or (b) smart defaults with power-user override. We can A/B test, but research favors fewer choices."

**"Make the button smaller":**

> "Fitts's Law: target acquisition time scales with size, inversely with distance. Below 44px, error rates climb sharply on mobile. Let's keep 44px polished, or track mis-click rate. Prediction: smaller = more support tickets."

**"Users will read the tooltip":**

> "Paradox of the Active User is well-documented — users don't read docs before using software. They start clicking. Whatever they need must be discoverable inline: hints, defaults, contextual help. Relying on tooltips being read = designing for a user who doesn't exist."

**"Good enough, let's ship":**

> "Aesthetic-Usability Effect cuts both ways — users rate prettier interfaces as more usable even when they're not, masking problems in testing. Suggest: quick task-completion test (not just subjective ratings) before shipping. Risk: pretty interface users struggle with."

**"Why spend time on confirmation screen?":**

> "Peak-End Rule: people judge experiences by peak + end. This confirmation IS the lasting impression. Generic 'Thank you' = wasted opportunity. Mailchimp's 'High Five' built brand loyalty. Low effort, high impact."

**"Let users configure it":**

> "Tesler's Law — complexity lives somewhere. Pushing it to users = cognitive load per setting exposed. Better: pick good defaults in code, expose config for the 10% who need it."

**"But competitor does it this way":**

> "That's evidence FOR Jakob's Law, not against. Their users learned patterns there. We leverage that mental model (lower curve, faster value) or fight it (novelty cost). What specific advantage does our different approach give the user?"

### Metrics-Focused (for product managers, founders, growth teams)

**"Add more options":**

> "Every option we add has measurable cost. Our data shows [X]% drop-off per additional field in this flow. Hick's Law isn't just theory — it predicts our specific conversion decline. Test: hide half these options behind 'Advanced' and measure completion rate change."

**"Make the button smaller":**

> "Smaller button = predicted [X]% increase in mis-taps based on Fitts's research. On mobile that means accidental form submits, wrong-page navigations, frustrated users. Cost of keeping it 44px: zero. Cost of shrinking: support volume + rage-taps."

**"Good enough, ship it":**

> "I hear 'ship it.' Question: will pretty-but-clunky cost us in retention? Aesthetic-Usability Effect means users give us credit now but may churn 2-3 weeks from frustration. Suggest: 1-week shadow test — watch 5 real users attempt core tasks. If >2 struggle on the same thing, fix it before broad ship."

**"Why spend time on confirmation screen?":**

> "This screen = final touchpoint before user leaves flow. Peak-End research shows this moment weights disproportionately in overall satisfaction. Our NPS correlates more with checkout-complete experience than with mid-funnel experience. Investment here has outsized ROI."

### Standards-Based (for clients, enterprise, regulated industries)

**"Add more options":**

> "Industry standard for [this type of form] is [N] fields per step (per Nielsen Norman Group / Interaction Design Foundation benchmarks). We're currently at [2N]. Recommendation: split into steps following established patterns. This aligns with WCAG 2.1 cognitive accessibility guidelines too."

**"Make the button smaller":**

> "WCAG 2.1 Target Size Guidelines (2.5.8) recommend minimum 44×44px CSS pixels for touch targets. iOS HIG and Material Design both mandate this. Going below creates accessibility non-compliance risk and fails standard heuristic evaluation."

**"Competitor does it differently":**

> "Our competitors follow established conventions because those conventions are based on decades of usability research (Nielsen Norman, Interaction Design Foundation, W3C WAI-AG). Deviating from convention requires justification beyond differentiation — we need measurable user benefit to offset the learning cost we're imposing."

---

## Accessibility Overlay

| Law                                | a11y Consideration                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Fitts's**                        | Large targets help motor-impaired + elderly. 44px = a11y best practice.                                             |
| **Von Restorff**                   | Never color-alone emphasis. Size + weight + shape + position + text.                                                |
| **Doherty**                        | `prefers-reduced-motion`. Replace animations with instant transitions.                                              |
| **Miller's / Cognitive Load**      | Screen reader users benefit MORE from chunking/simplification. Cognitive disabilities magnify extraneous load.      |
| **Postel's**                       | Assistive tech compatibility = "liberal in what you accept." Keyboard-only, screen reader, switch devices.          |
| **Hick's**                         | Cognitive a11y: attention disorders hit hardest by choice overload. Even more reason to limit.                      |
| **Color Contrast** (cross-cutting) | All visual laws must meet **WCAG AA**: 4.5:1 normal text, 3:1 large text. Test with Stark Contrast or axe DevTools. |

---

## References

- [lawsofux.com](https://lawsofux.com) — Jon Yablonski (primary source)
- [Nielsen Norman Group](https://www.nngroup.com/) — Deep-dive research articles
- _Designing with the Mind in Mind_ — Jeff Johnson
- _100 Things Every Designer Needs to Know About People_ — Susan Weinschenk
- [W3C WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) — Accessible patterns
- [Baymard Institute](https://baymard.com/) — Checkout UX benchmarks
- [Interaction Design Foundation](https://www.interaction-design.org/) — Course material & glossary
