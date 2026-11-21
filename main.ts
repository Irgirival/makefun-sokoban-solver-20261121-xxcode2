// Roomwise push-optimal Sokoban solver.
//
// Idea: the levels in this competition are a hallway with small rooms off it
// (three or four boxes each), and a box never leaves its room, so the whole
// level is the sum of its rooms. This program cuts the level into rooms,
// solves every room push-optimally on its own, and stitches the answers
// together with plain walks through the hallway. A room is solved by an A*
// over pushes (one push moves one box one square), guided by the cheapest
// assignment of boxes to goals, with dead squares and frozen 2x2 blocks
// pruned. The search is deterministic: every budget is a count of expanded
// states, never the wall clock, so two runs write the same bytes.
//
// Node 22, standard library only. Run: node main.ts, with
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR (defaults /input, /output).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Four steps: dx, dy, the walk letter, the push letter.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Expansion budgets, all counts, so the program is deterministic.
const ASTAR_BUDGET = 200_000;
const WEIGHTED_BUDGET = 120_000;
const GREEDY_BUDGET = 60_000;
const WHOLE_ASTAR_BUDGET = 500_000;
const WHOLE_WEIGHTED_BUDGET = 200_000;
const WHOLE_GREEDY_BUDGET = 100_000;
const GLOBAL_BUDGET = 3_000_000;
const GREEDY_ONLY_BUDGET = 20_000;

const INF = 1e9;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse an XSB level: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Live squares: the squares from which a box can still be pushed onto some
 * goal, found by pulling backwards from the goals over open floor. A box
 * standing on any other square (that is not itself a goal) can never be
 * solved, so a state holding one is dead. The hallway squares of these
 * levels are never live: a box out there cannot come back through a door.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      // A box on y could have been pushed to x by a player standing on y - d.
      if (y >= 0 && y < wall.length && !wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from one goal over open floor (walls block, boxes do not), -1 where unreachable. */
function distancesFrom(w: number, wall: Uint8Array, goal: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Cheapest assignment of boxes to goals under the walking distances, over
 * every ordering (at most four boxes, so at most 24). Infinity when no
 * assignment reaches every goal: such a state can never be solved.
 * Each push moves one box one square, so this sum drops by at most one per
 * push: an admissible, consistent estimate of the pushes still needed.
 */
function matchingCost(boxes: number[], goals: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  const order = goals.map((_, i) => i);
  let best = INF;
  const permute = (k: number): void => {
    if (k === n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dists[order[i]!]![boxes[i]!]!;
        if (d < 0) return;
        sum += d;
        if (sum >= best) return;
      }
      if (sum < best) best = sum;
      return;
    }
    for (let i = k; i < n; i++) {
      [order[k], order[i]] = [order[i]!, order[k]!];
      permute(k + 1);
      [order[k], order[i]] = [order[i]!, order[k]!];
    }
  };
  permute(0);
  return best;
}

/** The squares a player reaches from `from` around walls and boxes; returns the lowest such square. */
function reachable(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** A binary heap ordered by (f, h, insertion order): deterministic ties. */
class Heap {
  a: [number, number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[i]!, a[p]!)) {
        [a[i], a[p]] = [a[p]!, a[i]!];
        i = p;
      } else break;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1]!, a[c]!)) c++;
        if (!Heap.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
  private static less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
    return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
  }
}

type SearchResult = { pushes: number; moves: string } | null;

/**
 * A push-space search over one board: states are the sorted box squares plus
 * the player's reachable region (named by its lowest square). Expands the
 * most promising state first, f = pushes + weight * estimate; weight 1 is
 * A* (push-optimal), a larger weight hurries, and a huge weight is greedy.
 * Gives up after `budget` expansions, or when the shared `shared` counter
 * passes its cap. Returns the moves (lowercase walks, uppercase pushes) or
 * null.
 */
function search(
  board: Board,
  budget: number,
  weight: number,
  shared: { used: number; cap: number },
): SearchResult {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  const dists = goals.map((g) => distancesFrom(w, wall, g));
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (board.boxes.some((b) => !live[b])) return null;

  const keyOf = (bs: number[], low: number): string => bs.join(',') + '|' + low;
  const boxesList: number[][] = [board.boxes.slice()];
  const playerList: number[] = [board.player];
  const lowList: number[] = [];
  const gList: number[] = [0];
  const parentList: number[] = [-1];
  const pushFromList: number[] = [-1];
  const pushDirList: number[] = [-1];
  const best = new Map<string, number>();
  const closed = new Set<number>();
  for (const b of board.boxes) occupied[b] = 1;
  const startLow = reachable(w, wall, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  lowList.push(startLow);
  best.set(keyOf(board.boxes, startLow), 0);
  const heap = new Heap();
  const h0 = matchingCost(board.boxes, goals, dists);
  if (h0 >= INF) return null;
  let seq = 0;
  heap.push([h0, h0, seq++, 0]);
  let expanded = 0;
  let found = -1;
  if (solved(board.boxes)) found = 0;

  while (heap.size > 0 && found < 0) {
    const [, , , s] = heap.pop();
    if (closed.has(s)) continue;
    const bs = boxesList[s]!;
    // Stale entry: a cheaper route to this state was already recorded.
    if (best.get(keyOf(bs, lowList[s]!)) !== gList[s]) continue;
    // A goal state is optimal only when it is popped, not when generated:
    // the heap's smallest f is a lower bound on every other route.
    if (solved(bs)) {
      found = s;
      break;
    }
    if (expanded >= budget || shared.used >= shared.cap) return null;
    expanded++;
    shared.used++;
    closed.add(s);
    const g = gList[s]!;
    for (const b of bs) occupied[b] = 1;
    const here = ++stamp;
    reachable(w, wall, occupied, playerList[s]!, seen, here, stack);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const from = b - d;
        const to = b + d;
        if (seen[from] !== here || wall[to] || occupied[to] || !live[to]) continue;
        occupied[b] = 0;
        occupied[to] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, to);
        let next: number[] | null = null;
        let nkey = '';
        let nlow = -1;
        if (!frozen) {
          next = bs.slice();
          next[bi] = to;
          next.sort((x, y) => x - y);
          nlow = reachable(w, wall, occupied, b, mark, ++stamp, stack);
          nkey = keyOf(next, nlow);
        }
        occupied[to] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const seenG = best.get(nkey);
        if (seenG !== undefined && seenG <= g + 1) continue;
        const h = matchingCost(next, goals, dists);
        if (h >= INF) continue;
        best.set(nkey, g + 1);
        const t = boxesList.length;
        boxesList.push(next);
        playerList.push(b);
        lowList.push(nlow);
        gList.push(g + 1);
        parentList.push(s);
        pushFromList.push(b);
        pushDirList.push(di);
        heap.push([g + 1 + weight * h, h, seq++, t]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Walk the parents back into the push list, then spell it out as moves.
  const pushes: { from: number; dir: number }[] = [];
  for (let s = found; s > 0; s = parentList[s]!) pushes.push({ from: pushFromList[s]!, dir: pushDirList[s]! });
  pushes.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const p of pushes) {
    const [dx, dy, , letter] = DIRS[p.dir]!;
    const d = dy * w + dx;
    const to = p.from + d;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, p.from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += letter;
    player = p.from;
    const at = boxes.indexOf(p.from);
    boxes[at] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: pushes.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, lowercase LURD (first direction first on ties). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/**
 * Cut a level into rooms: the player's row is the hallway, and its squares
 * no box can ever reach a goal from are cut out; each leftover part holding
 * boxes is a room. Null when the level is no set of rooms (a box starts in
 * the hallway, a goal sits on a cut square, or some part's boxes and goals
 * do not match).
 */
function roomsOf(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Try the search ladder on one board: A*, then weighted A*, then greedy. */
function solveBoard(
  board: Board,
  budgets: [number, number, number],
  shared: { used: number; cap: number },
): SearchResult {
  let r = search(board, budgets[0], 1, shared);
  if (r !== null) return r;
  r = search(board, budgets[1], 2, shared);
  if (r !== null) return r;
  return search(board, budgets[2], INF, shared);
}

/** The end square of `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Solve one level room by room: each room's push-optimal answer in turn,
 * the other rooms' boxes standing as walls, the player walking on from
 * where the last room left it. A box never leaves its room, so the rooms'
 * optima add up to the level's. Falls back to the whole level when the
 * level is no set of rooms.
 */
function solveLevel(level: Board, shared: { used: number; cap: number }): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const r = solveBoard(level, [WHOLE_ASTAR_BUDGET, WHOLE_WEIGHTED_BUDGET, WHOLE_GREEDY_BUDGET], shared);
    return r === null ? '' : r.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const budgets: [number, number, number] =
      shared.used >= shared.cap
        ? [0, 0, GREEDY_ONLY_BUDGET]
        : [ASTAR_BUDGET, WEIGHTED_BUDGET, GREEDY_BUDGET];
    const solved = solveBoard(sub, budgets, shared);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

const shared = { used: 0, cap: GLOBAL_BUDGET };
for (const id of readdirSync(INPUT).sort()) {
  const level = parseLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  const moves = solveLevel(level, shared);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
