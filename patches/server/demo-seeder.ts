import { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';

export async function seedDemoData(client: PoolClient): Promise<void> {
  const passwordHash = await bcrypt.hash('demo-password', 10);

  // Create 3 fake users
  const users = await client.query(`
    INSERT INTO users (username, password_hash, role, display_name, email) VALUES
      ('alice', $1, 'ADMIN', 'Alice Chen', 'alice@demo.example'),
      ('bob', $1, 'MEMBER', 'Bob Martinez', 'bob@demo.example'),
      ('carol', $1, 'MEMBER', 'Carol Wu', 'carol@demo.example')
    RETURNING id, username
  `, [passwordHash]);

  const alice = users.rows[0];
  const bob = users.rows[1];
  const carol = users.rows[2];

  // Create board
  const board = await client.query(`
    INSERT INTO boards (name, description, created_by)
    VALUES ('Product Roadmap', 'Track features, bugs, and design tasks across the product lifecycle.', $1)
    RETURNING id
  `, [alice.id]);
  const boardId = board.rows[0].id;

  // Add all users as board members
  await client.query(`
    INSERT INTO board_members (board_id, user_id, role) VALUES
      ($1, $2, 'ADMIN'),
      ($1, $3, 'EDITOR'),
      ($1, $4, 'EDITOR')
  `, [boardId, alice.id, bob.id, carol.id]);

  // Create columns
  const cols = await client.query(`
    INSERT INTO columns (board_id, name, position) VALUES
      ($1, 'Backlog', 0),
      ($1, 'In Progress', 1),
      ($1, 'In Review', 2),
      ($1, 'Done', 3)
    RETURNING id, name
  `, [boardId]);

  const colMap: Record<string, string> = {};
  for (const c of cols.rows) colMap[c.name] = c.id;

  // Create labels
  const labels = await client.query(`
    INSERT INTO board_labels (board_id, name, color) VALUES
      ($1, 'Bug', '#ef4444'),
      ($1, 'Feature', '#3b82f6'),
      ($1, 'Design', '#8b5cf6'),
      ($1, 'Infra', '#f59e0b')
    RETURNING id, name
  `, [boardId]);

  const labelMap: Record<string, string> = {};
  for (const l of labels.rows) labelMap[l.name] = l.id;

  // Card definitions: [title, description, column, position, label, dueDayOffset|null, assigneeId]
  const cardDefs: [string, string, string, number, string, number | null, typeof alice][] = [
    // Backlog (5)
    ['Add OAuth support', 'Implement OAuth 2.0 flows for Google and GitHub authentication.', 'Backlog', 0, 'Feature', 14, bob],
    ['Stripe billing integration', 'Add subscription billing with Stripe for premium features.', 'Backlog', 1, 'Feature', 21, alice],
    ['Keyboard shortcuts guide', 'Create an interactive keyboard shortcuts overlay for power users.', 'Backlog', 2, 'Design', 18, carol],
    ['API rate limiting dashboard', 'Build a dashboard to monitor and configure API rate limits.', 'Backlog', 3, 'Infra', null, bob],
    ['Multi-language support', 'Add i18n framework and translate core UI strings to 5 languages.', 'Backlog', 4, 'Feature', 30, alice],

    // In Progress (5)
    ['Dark mode polish', 'Refine dark mode colors and fix contrast issues in modals and dropdowns.', 'In Progress', 0, 'Design', 3, carol],
    ['Onboarding flow redesign', 'Simplify the new user onboarding with a step-by-step wizard.', 'In Progress', 1, 'Design', 5, alice],
    ['Fix mobile drag scroll', 'Drag and drop scrolling is broken on iOS Safari when board overflows.', 'In Progress', 2, 'Bug', 2, bob],
    ['WebSocket reconnection handling', 'Gracefully reconnect WebSocket when connection drops without losing state.', 'In Progress', 3, 'Bug', 7, bob],
    ['Card activity timeline', 'Show a visual timeline of all card changes with diff highlighting.', 'In Progress', 4, 'Feature', 4, carol],

    // In Review (4)
    ['Email notification templates', 'Design and implement HTML email templates for all notification types.', 'In Review', 0, 'Feature', 1, alice],
    ['Board export to PDF', 'Allow exporting board state as a formatted PDF document.', 'In Review', 1, 'Feature', -1, bob],
    ['Fix column reorder animation', 'Column drag animation glitches when moving to the last position.', 'In Review', 2, 'Bug', 2, carol],
    ['Search performance optimization', 'Add full-text search indexes and query caching to improve speed.', 'In Review', 3, 'Infra', 0, bob],

    // Done (4)
    ['User avatar uploads', 'Support profile image uploads with automatic resizing and cropping.', 'Done', 0, 'Feature', -5, carol],
    ['Card due date reminders', 'Send notifications when cards are approaching their due date.', 'Done', 1, 'Feature', -3, alice],
    ['Fix duplicate card bug', 'Prevent duplicate cards created when double-clicking the create button.', 'Done', 2, 'Bug', -7, bob],
    ['Database connection pooling', 'Configure PgBouncer for efficient database connection management.', 'Done', 3, 'Infra', -4, alice],
  ];

  const cardIds: string[] = [];

  for (const [title, description, column, position, label, dueDayOffset, assignee] of cardDefs) {
    const dueExpr = dueDayOffset !== null
      ? `CURRENT_DATE + INTERVAL '${dueDayOffset} days'`
      : 'NULL';

    const card = await client.query(`
      INSERT INTO cards (column_id, title, description, position, due_date)
      VALUES ($1, $2, $3, $4, ${dueExpr})
      RETURNING id
    `, [colMap[column], title, description, position]);

    const cardId = card.rows[0].id;
    cardIds.push(cardId);

    // Assign label
    await client.query(
      'INSERT INTO card_labels (card_id, label_id) VALUES ($1, $2)',
      [cardId, labelMap[label]]
    );

    // Assign user
    await client.query(
      'INSERT INTO card_assignees (card_id, user_id) VALUES ($1, $2)',
      [cardId, assignee.id]
    );
  }

  // Comments: realistic conversations on each card
  const commentData: [number, typeof alice, string][] = [
    // Backlog cards
    [0, bob, 'I can start on the Google OAuth flow next sprint. GitHub should be straightforward after that.'],
    [0, alice, 'Make sure we support both authorization code and PKCE flows.'],
    [0, carol, 'I\'ll prep the login page UI to accommodate the OAuth buttons.'],
    [1, alice, 'We should use Stripe Checkout for the initial implementation — simpler than the full API.'],
    [1, bob, 'Agreed. We also need webhook handlers for subscription lifecycle events.'],
    [2, carol, 'I\'m thinking a modal overlay triggered by ? key, similar to GitHub.'],
    [2, alice, 'Love it. Can we also add a search/filter for shortcuts?'],
    [3, bob, 'We should track requests per endpoint and show P95 latency.'],
    [3, carol, 'Maybe use a time-series chart for the last 24 hours?'],
    [4, alice, 'Let\'s start with Spanish, French, German, Japanese, and Chinese.'],
    [4, bob, 'I\'ll set up the i18n extraction pipeline.'],
    [4, carol, 'We should use ICU message format for pluralization.'],

    // In Progress cards
    [5, carol, 'The modal backdrop color needs to be darker in dark mode — it\'s barely visible.'],
    [5, alice, 'Also check the dropdown menus, some have hardcoded white backgrounds.'],
    [5, bob, 'I noticed the card labels are hard to read in dark mode too.'],
    [6, alice, 'Step 1: create board, Step 2: add first card, Step 3: invite teammate.'],
    [6, carol, 'Should we add a sample board option to skip the manual steps?'],
    [7, bob, 'Reproduced on iPhone 14 Safari. The scroll gets locked when dragging near edges.'],
    [7, alice, 'This might be related to touch-action CSS. Try adding touch-action: none on drag handles.'],
    [8, bob, 'I\'m implementing exponential backoff with jitter for reconnection attempts.'],
    [8, carol, 'Make sure we show a subtle reconnecting indicator in the UI.'],
    [8, alice, 'Good call. A small toast at the bottom would work.'],
    [9, carol, 'Using a vertical timeline with icons for each action type — move, edit, comment, etc.'],
    [9, bob, 'Can we add a "show diff" toggle for description changes?'],

    // In Review cards
    [10, alice, 'Templates are done. Using MJML for cross-client compatibility.'],
    [10, bob, 'Looks great! The card assignment notification could use the assignee\'s avatar.'],
    [10, carol, 'Tested in Gmail, Outlook, and Apple Mail — all rendering correctly.'],
    [11, bob, 'PDF generation is working with Puppeteer. Each column becomes a page section.'],
    [11, alice, 'This is past due — can we wrap up the review today?'],
    [12, carol, 'Fixed the animation by recalculating positions after DOM update. PR is up.'],
    [12, bob, 'LGTM. The transition feels much smoother now.'],
    [13, bob, 'Added GIN indexes on cards.title and cards.description. 10x improvement on search queries.'],
    [13, alice, 'Nice gains! Let\'s also add an index on card_comments.text.'],

    // Done cards
    [14, carol, 'Implemented with sharp.js — supports JPEG, PNG, and WebP. Auto-crops to square.'],
    [14, alice, 'Shipped! Users are already uploading avatars.'],
    [15, alice, 'Reminders fire 24h and 1h before due date. Configurable in notification preferences.'],
    [15, bob, 'Working perfectly. Got my first reminder today!'],
    [16, bob, 'Added a debounce on the create button and server-side idempotency key.'],
    [16, carol, 'Verified the fix — no more duplicates even with rapid clicking.'],
    [16, alice, 'Great fix. This was really annoying users.'],
    [17, alice, 'PgBouncer is configured in transaction mode. Connection count dropped from 50 to 5.'],
    [17, bob, 'Monitoring looks good. No connection timeouts in the last 48 hours.'],
  ];

  for (const [cardIndex, user, text] of commentData) {
    await client.query(
      'INSERT INTO card_comments (card_id, user_id, text) VALUES ($1, $2, $3)',
      [cardIds[cardIndex], user.id, text]
    );
  }
}
