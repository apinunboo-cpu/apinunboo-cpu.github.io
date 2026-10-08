/* =====================================================================
 * Barbarian Codex — offline database app for the web novel
 * "Surviving the Game as a Barbarian".
 *
 * Plain browser JavaScript (ES2018), no framework, no build step and no
 * network access. It works from file:// because every data file arrives
 * through a <script> tag:
 *   data/db.js              sets window.DB (loaded by index.html)
 *   data/story/<arcId>.js   fills window.STORY[arcId] (injected on demand)
 *
 * Routes live in location.hash, e.g. #/monsters?grade=3, #/monster/ogre,
 * #/chapter/138, #/maps, #/search?q=ogre, #/check (data report).
 *
 * Map of this file
 *   1. Utilities ......... escaping, html`` template, safe storage, text keys
 *   2. I18N .............. UI strings (EN/TH), enum and colour translations
 *   3. Data .............. normalise window.DB once, build lookup indexes
 *   4. Text helpers ...... t(), names, links, badges, swatches, chips
 *   5. Markdown .......... the small subset used by summaries and lore
 *   6. Components ........ crumbs, infobox, sections, tables, timelines
 *   7. Categories ........ list columns + filters + detail page per category
 *   8. Views ............. home, list, detail, maps, story, arc, chapter,
 *                          search, data check, not found
 *   9. Search ............ global index + the dropdown search box widget
 *  10. Chrome ............ header (nav, language menu, theme), footer
 *  11. Router + boot
 * ===================================================================== */
(function () {
  'use strict';

  /* =================================================================
   * 1. Utilities
   * ================================================================= */

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** A string that is already safe HTML (output of html`` or trusted markup). */
  class Raw {
    constructor(s) { this.s = s; }
    toString() { return this.s; }
  }
  const raw = (s) => new Raw(s == null ? '' : String(s));

  /** Any value -> HTML. Raw passes through, arrays are joined, null and
   *  booleans vanish (so `${cond && x}` is safe), everything else is escaped.
   *  NOTE: never interpolate a boolean you want printed — use String(b). */
  function toHtml(v) {
    if (v == null || typeof v === 'boolean') return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) { let o = ''; for (const x of v) o += toHtml(x); return o; }
    return esc(v);
  }

  /** Tagged template that escapes every interpolation: html`<b>${name}</b>`. */
  function html(strings, ...vals) {
    let o = strings[0];
    for (let i = 0; i < vals.length; i++) o += toHtml(vals[i]) + strings[i + 1];
    return new Raw(o);
  }
  const blank = (h) => toHtml(h).trim() === '';
  /** Join HTML fragments, skipping empty ones. */
  function joinHtml(items, sep) {
    const parts = items.map(toHtml).filter((s) => s.trim() !== '');
    return raw(parts.join(sep == null ? ', ' : toHtml(sep)));
  }

  /** localStorage that never throws (private mode, blocked site data, previews). */
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable: keep going */ } },
  };

  /** Search/lookup key: lower case, Latin accents and apostrophes removed, spaces collapsed.
   *  Thai text passes through unchanged (its vowel marks are not in the stripped range). */
  function norm(s) {
    if (s == null) return '';
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[’'`´]/g, '').replace(/\s+/g, ' ').trim();
  }
  /** Id-style slug: "Kraul's Demon Grinder" -> "krauls-demon-grinder". */
  const slug = (s) => norm(s).replace(/[^a-z0-9฀-๿]+/g, '-').replace(/^-+|-+$/g, '');
  const ID_LIKE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  /** Readable text for an unresolved id ("living-armor" -> "Living Armor"); free text is kept. */
  function prettyId(s) {
    s = String(s == null ? '' : s);
    if (!ID_LIKE.test(s) || /^\d+$/.test(s)) return s;
    return s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
  const toInt = (x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : null; };
  const fmtNum = (n) => Number(n).toLocaleString('en-US');
  const cap = (s) => { s = String(s == null ? '' : s); return s.charAt(0).toUpperCase() + s.slice(1); };
  function debounce(fn, ms) {
    let tm = 0;
    return function (...a) { clearTimeout(tm); tm = setTimeout(() => fn.apply(this, a), ms); };
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  /** Cache a per-entity computation by id (data never changes after boot). */
  function memo(fn) {
    const m = new Map();
    return (e) => { let v = m.get(e.id); if (v === undefined) { v = fn(e); m.set(e.id, v); } return v; };
  }

  /* =================================================================
   * 2. I18N — every piece of UI text in one dictionary (EN + TH).
   *    T('key', {var}) for UI strings; t(obj) for bilingual data fields.
   *    A key missing in TH falls back to EN.
   * ================================================================= */
  const I18N = {};
  I18N.en = {
    'skip': 'Skip to content',
    'app.loadFail.title': 'The data file did not load',
    'app.loadFail.body': 'data/db.js is missing or contains a syntax error, so there is nothing to show. Check the file in the data folder next to index.html.',
    'app.crash': 'Something went wrong while showing this page.',

    'nav.home': 'Home', 'nav.story': 'Story', 'nav.races': 'Races', 'nav.characters': 'Characters',
    'nav.monsters': 'Monsters', 'nav.essences': 'Essences', 'nav.skills': 'Skills', 'nav.items': 'Items',
    'nav.maps': 'Maps', 'nav.factions': 'Factions', 'nav.lore': 'World Rules', 'nav.label': 'Database sections',

    'cat.races': 'Races', 'cat.characters': 'Characters', 'cat.monsters': 'Monsters', 'cat.essences': 'Essences',
    'cat.skills': 'Skills', 'cat.items': 'Items', 'cat.locations': 'Locations', 'cat.factions': 'Factions',
    'cat.lore': 'World rules', 'cat.chapters': 'Chapters', 'cat.arcs': 'Arcs',
    'one.races': 'race', 'one.characters': 'character', 'one.monsters': 'monster', 'one.essences': 'essence',
    'one.skills': 'skill', 'one.items': 'item', 'one.locations': 'location', 'one.factions': 'faction', 'one.lore': 'world rule',

    'lede.races': 'The races of the story, their traits, and racial abilities with examples from the chapters.',
    'lede.characters': 'Everyone who matters in the story: race, role, status, essences and how they progress.',
    'lede.monsters': 'Monsters by grade, floor and category, with abilities, drops and the essence they leave.',
    'lede.essences': 'Essences with their stat changes, passive skills and active skills by colour.',
    'lede.skills': 'Essence skills, spells, auras, racial abilities and item skills.',
    'lede.items': 'Numbers Items, equipment, consumables and materials.',
    'lede.locations': 'Every place in the database.',
    'lede.factions': 'Clans, guilds, churches, secret societies and nations.',
    'lede.lore': 'How the world works: stats, essences, rifts, currency and the other rules.',

    'tile.story': 'Arcs and Thai scene summaries', 'tile.races': 'Traits and racial abilities',
    'tile.characters': 'Roles, essences, timelines', 'tile.monsters': 'Grades, floors, drops',
    'tile.essences': 'Stats and skills by colour', 'tile.skills': 'Effects, sources, users',
    'tile.items': 'Numbers Items and gear', 'tile.locations': 'Labyrinth floors, zones, cities',
    'tile.factions': 'Clans, guilds, churches', 'tile.lore': 'How the world works',

    'home.intro': 'Look up any race, character, monster, essence, skill, item, place or rule from the novel, see exactly which chapters it appears in, and read a Thai summary of every chapter. Everything works offline.',
    'home.try': 'Try', 'home.searchBtn': 'Search', 'home.browse': 'Browse the database', 'home.how': 'How to use',
    'how.search': 'Press / anywhere to search every category by English or Thai name, alias or chapter number. Enter opens the first hit.',
    'how.lists': 'Open a category from the menu. Click a column header to sort, and use the filters above the table to narrow it down.',
    'how.links': 'Every name is a link. Each entry ends with the chapters it appears in.',
    'how.story': 'Story has a Thai scene-by-scene summary of each chapter. Use the ← and → keys to move between chapters.',
    'how.lang': 'Switch between English and Thai at the top right. In Thai, names show with the English name beside them.',
    'home.grades': 'Grades', 'home.gradesNote': 'Grade 9 is the weakest and Grade 1 the strongest. Monsters, essences and magic stones share the same scale.',
    'home.colors': 'Essence colours', 'home.coverage': 'Data coverage',
    'cov.range': 'Chapters', 'cov.missing': 'Not in the source', 'cov.inDb': 'Chapters in the database', 'cov.sum': 'Chapters summarized so far',
    'cov.version': 'Data version', 'cov.generated': 'Generated', 'cov.have': 'In the database',
    'cov.missLegend': 'Not in the source', 'cov.none': 'None', 'cov.partial': 'Incomplete in the source',

    'search.placeholder': 'Search names, aliases, chapters', 'search.label': 'Search the codex',
    'search.cat': 'Search in', 'search.all': 'All categories', 'search.seeAll': 'See all results for “{q}”',
    'search.none': 'No matches for “{q}”.', 'search.title': 'Search', 'search.results': '{n} results for “{q}”',
    'search.results1': '1 result for “{q}”', 'search.prompt': 'Type an English or Thai name, an alias, or a chapter number.',
    'search.inList': 'Open as a list', 'search.toggle': 'Search', 'search.capped': 'Showing the best {n}.',
    'search.hintKey': 'Press / to search', 'search.noChapter': 'Not in the database yet',

    'theme.toLight': 'Switch to light theme', 'theme.toDark': 'Switch to dark theme',
    'lang.label': 'Language: {l}', 'lang.en': 'English', 'lang.th': 'Thai',

    'list.search': 'Search this list', 'list.searchPh': 'Name, Thai name or alias', 'list.any': 'Any',
    'list.clear': 'Clear filters', 'list.count': '{n} entries', 'list.count1': '1 entry',
    'list.countOf': '{n} of {total} entries match', 'list.showing': 'Showing {a}–{b}',
    'list.emptyFiltered': 'Nothing matches these filters.', 'list.emptyNone': 'No {cat} in the database yet.',
    'list.prev': 'Previous', 'list.next': 'Next', 'list.pages': 'Pages', 'list.sortHint': 'Click a column header to sort.',
    'list.mapLink': 'See Maps for the location tree and the Labyrinth diagram.',

    'col.name': 'Name', 'col.title': 'Title', 'col.grade': 'Grade', 'col.category': 'Category', 'col.floors': 'Floors',
    'col.floor': 'Floor', 'col.zones': 'Zones', 'col.essence': 'Essence', 'col.monster': 'Monster', 'col.colors': 'Colours',
    'col.stats': 'Stats', 'col.users': 'Users', 'col.kind': 'Kind', 'col.source': 'Source', 'col.cost': 'Cost',
    'col.cooldown': 'Cooldown', 'col.number': 'No.', 'col.material': 'Material', 'col.price': 'Price', 'col.owners': 'Owners',
    'col.race': 'Race', 'col.roles': 'Roles', 'col.status': 'Status', 'col.importance': 'Importance', 'col.evil': 'Evil spirit',
    'col.first': 'First ch.', 'col.chapters': 'Chapters', 'col.parent': 'Inside', 'col.monsters': 'Monsters',
    'col.leader': 'Leader', 'col.members': 'Members', 'col.topic': 'Topic', 'col.abilities': 'Racial abilities',
    'col.people': 'Characters',

    'f.grade': 'Grade', 'f.floor': 'Floor', 'f.category': 'Category', 'f.color': 'Colour', 'f.hasUser': 'Users',
    'f.kind': 'Kind', 'f.source': 'Source type', 'f.numbered': 'Numbers Item', 'f.race': 'Race',
    'f.importance': 'Importance', 'f.status': 'Status', 'f.evil': 'Evil spirit', 'f.topic': 'Topic',
    'opt.yes': 'Yes', 'opt.no': 'No', 'opt.hasUsers': 'Has users', 'opt.noUsers': 'No users',
    'opt.numbered': 'Numbered', 'opt.notNumbered': 'Not numbered', 'opt.unknown': 'Unknown',

    'imp.1': 'Main', 'imp.2': 'Supporting', 'imp.3': 'Minor',
    'grade.n': 'Grade {n}', 'grade.weakest': 'Weakest', 'grade.strongest': 'Strongest',
    'floor.n': 'Floor {n}', 'floor.ug': 'Underground {n}',
    'ch.short': 'Ch. {n}',
    'yes': 'Yes', 'no': 'No', 'unknown': 'Unknown',
    'ref.missing': 'Not in the database yet',
    'tag.en': 'Thai text not available yet, showing English',

    'lbl.aliases': 'Also known as', 'lbl.id': 'ID', 'lbl.first': 'First appearance', 'lbl.grade': 'Grade',
    'lbl.category': 'Category', 'lbl.floors': 'Floors', 'lbl.zones': 'Zones', 'lbl.essence': 'Essence',
    'lbl.monster': 'Monster', 'lbl.madeFrom': 'Made from', 'lbl.colors': 'Colours', 'lbl.users': 'Users', 'lbl.kind': 'Kind', 'lbl.source': 'Source',
    'lbl.cost': 'Cost', 'lbl.cooldown': 'Cooldown', 'lbl.number': 'Number', 'lbl.material': 'Material',
    'lbl.price': 'Price', 'lbl.race': 'Race', 'lbl.gender': 'Gender', 'lbl.roles': 'Roles',
    'lbl.affiliations': 'Affiliations', 'lbl.status': 'Status', 'lbl.evil': 'Evil spirit', 'lbl.mask': 'Round Table mask',
    'lbl.importance': 'Importance', 'lbl.parent': 'Inside', 'lbl.path': 'Path', 'lbl.floor': 'Floor',
    'lbl.leader': 'Leader', 'lbl.members': 'Members', 'lbl.topic': 'Topic', 'lbl.owners': 'Owners',
    'lbl.notable': 'Notable members', 'lbl.people': 'Characters', 'lbl.monsters': 'Monsters',
    'lbl.inside': 'Places inside', 'lbl.chapters': 'Chapters', 'lbl.infobox': 'Quick facts',

    'sec.summary': 'Summary', 'sec.appearance': 'Appearance', 'sec.abilities': 'Abilities', 'sec.weakness': 'Weakness',
    'sec.behavior': 'Behaviour', 'sec.drops': 'Drops', 'sec.essence': 'Essence', 'sec.encounters': 'Encounters',
    'sec.stats': 'Stats', 'sec.passive': 'Passive skills', 'sec.actives': 'Active skills by colour',
    'sec.activeShort': 'Active skills', 'sec.users': 'Users', 'sec.personality': 'Personality',
    'sec.essences': 'Essences', 'sec.skills': 'Skills', 'sec.items': 'Items', 'sec.relationships': 'Relationships',
    'sec.timeline': 'Progression timeline', 'sec.traits': 'Traits', 'sec.raceAbilities': 'Racial abilities',
    'sec.roles': 'Common roles', 'sec.culture': 'Culture', 'sec.homeland': 'Homeland', 'sec.notable': 'Notable members',
    'sec.raceMembers': 'Characters of this race', 'sec.description': 'Description', 'sec.effects': 'Effects',
    'sec.owners': 'Owners', 'sec.obtained': 'How it is obtained', 'sec.features': 'Features', 'sec.rules': 'Rules',
    'sec.inside': 'Places inside', 'sec.monstersHere': 'Monsters found here', 'sec.members': 'Members',
    'sec.body': 'Details', 'sec.appears': 'Appears in chapters', 'sec.skillUsers': 'Characters with this skill',
    'sec.source': 'Source',

    'th.ability': 'Ability', 'th.effect': 'Effect', 'th.stat': 'Stat', 'th.value': 'Value', 'th.colour': 'Colour',
    'th.skill': 'Skill', 'th.trans': 'Transcendence', 'th.character': 'Character', 'th.chapter': 'Ch.',
    'th.note': 'Note', 'th.acquired': 'Acquired', 'th.relation': 'Relationship', 'th.what': 'What happened',
    'th.kind': 'Kind', 'th.source': 'Source', 'th.item': 'Item', 'th.number': 'No.', 'th.category': 'Category',
    'th.grade': 'Grade', 'th.name': 'Name', 'th.race': 'Race', 'th.roles': 'Roles', 'th.status': 'Status',
    'th.essence': 'Essence', 'th.monster': 'Monster',

    'appears.none': 'No chapter references recorded yet.', 'appears.summary': '{n} chapters, from Ch. {a} to Ch. {b}.',
    'appears.one': '1 chapter.', 'appears.more': 'Show {n} more',

    'story.title': 'Story', 'story.lede': 'The novel arc by arc. Every chapter has a short summary in English and Thai, plus a Thai scene-by-scene summary.',
    'story.ribbon': 'Arcs across chapters 1–{total}', 'story.noArcs': 'No arcs in the database yet.',
    'story.orphans': 'Chapters without an arc', 'story.coverage': '{have} of {total} chapters in the database',
    'arc.n': 'Arc {n}', 'arc.range': 'Ch. {a}–{b}', 'arc.subarcs': 'Sub-arcs', 'arc.chapters': 'Chapters',
    'arc.coverage': '{have} of {total} chapters summarised', 'arc.other': 'Other chapters',
    'arc.notFound': 'There is no arc with the id “{id}”.', 'arc.noChapters': 'No chapters of this arc are in the database yet.',
    'arc.colTitle': 'Sub-arc', 'arc.colTh': 'Thai title', 'arc.colRange': 'Chapters', 'arc.colHave': 'In database',

    'ch.title': 'Chapter {n}', 'ch.arc': 'Arc', 'ch.subarc': 'Sub-arc', 'ch.setting': 'Setting', 'ch.chars': 'Characters',
    'ch.tldr': 'In brief', 'ch.scenes': 'Scene summary', 'ch.thaiNote': 'Scene summaries are written in Thai.',
    'ch.loading': 'Loading the scene summary…', 'ch.noStory': 'No scene summary for this chapter yet.',
    'ch.fileMissing': 'Could not load {file}, so the scene summaries of this arc are missing.',
    'ch.prev': 'Previous chapter', 'ch.next': 'Next chapter', 'ch.jump': 'Jump to chapter', 'ch.go': 'Go',
    'ch.missingSrc': 'Chapter {n} does not exist in the source text; the original numbering skips it.',
    'ch.notInDb': 'Chapter {n} is not in the database yet.',
    'ch.partialSrc': 'The source file for chapter {n} is incomplete (about {have} of {total} words), so its summary and data cover only the opening part.',
    'ch.outOfRange': 'There is no chapter {n}. The novel runs from chapter 1 to {total}.',
    'ch.inThis': 'Also in this chapter', 'ch.keys': 'Tip: the ← and → keys move between chapters.',

    'maps.title': 'Maps', 'maps.lede': 'The Labyrinth floor by floor, and every location under the place that contains it.',
    'maps.lab': 'The Labyrinth', 'maps.tree': 'All locations', 'maps.table': 'Open the location table',
    'maps.expand': 'Expand all', 'maps.collapse': 'Collapse all', 'maps.noZones': 'No zones recorded yet',
    'maps.mon': '{n} monsters', 'maps.mon1': '1 monster', 'maps.mon0': 'No monsters yet',
    'maps.legend.zone': 'Zone', 'maps.legend.rift': 'Rift', 'maps.legend.hidden': 'Hidden field', 'maps.legend.island': 'Island',
    'maps.underground': 'Underground floors', 'maps.noLoc': 'No locations in the database yet.',
    'maps.top': 'Floor 1 is at the top; the deeper the floor, the darker its band.',
    'maps.noFloors': 'No Labyrinth floors in the database yet.', 'maps.floorMissing': 'No page for this floor yet',

    'nf.title': 'Page not found', 'nf.body': 'Nothing lives at “{h}”.', 'nf.entity': 'There is no {what} with the id “{id}”.',
    'nf.similar': 'Similar names', 'nf.back': 'Back to {cat}', 'nf.home': 'Go to the home page',

    'foot.about': 'Fan-made offline reference for Surviving the Game as a Barbarian.',
    'foot.data': 'Data version {v}', 'foot.generated': 'generated {d}', 'foot.check': 'Data check',

    'check.title': 'Data check', 'check.lede': 'For the data team: problems found in data/db.js. Fix them in the source data and regenerate the file; the site itself tolerates all of them.',
    'check.counts': 'Entries per category', 'check.dupes': 'Duplicate ids (only the first copy is used)',
    'check.noId': 'Entries without an id (ignored)', 'check.unres': 'Id references that match nothing',
    'check.unresNote': 'Values written like ids (lowercase-with-hyphens) that match no entry. The site shows them as plain text.',
    'check.free': 'Free-text references', 'check.freeNote': 'Names that are not ids and match no entry, name or alias. Allowed; shown as plain text.',
    'check.chapters': 'Chapters', 'check.noMeta': 'Chapter numbers with no entry in DB.chapters',
    'check.badArc': 'Chapters whose arc id is unknown', 'check.story': 'Story files',
    'check.storyBtn': 'Load and check every story file', 'check.storyOk': '{arc}: {n} chapter summaries',
    'check.storyMissing': '{arc}: data/story/{arc}.js is missing or broken', 'check.storyGaps': '{arc}: no summary for chapters {list}',
    'check.ok': 'No problems found.', 'check.field': 'Field', 'check.value': 'Value', 'check.entry': 'Entry',
    'check.count': 'Count', 'check.andMore': '…and {n} more',

    'color.red': 'Red', 'color.orange': 'Orange', 'color.yellow': 'Yellow', 'color.green': 'Green', 'color.blue': 'Blue',
    'color.indigo': 'Indigo', 'color.purple': 'Purple', 'color.black': 'Black', 'color.white': 'White', 'color.gold': 'Gold',
    'color.silver': 'Silver', 'color.rainbow': 'Rainbow', 'color.pink': 'Pink', 'color.brown': 'Brown', 'color.grey': 'Grey',
    'color.unknown': 'Colour unknown',
  };

  I18N.th = {
    'skip': 'ข้ามไปที่เนื้อหา',
    'app.loadFail.title': 'โหลดไฟล์ข้อมูลไม่สำเร็จ',
    'app.loadFail.body': 'ไม่พบไฟล์ data/db.js หรือไฟล์มีข้อผิดพลาด จึงไม่มีข้อมูลให้แสดง โปรดตรวจสอบไฟล์ในโฟลเดอร์ data ข้าง index.html',
    'app.crash': 'เกิดข้อผิดพลาดระหว่างแสดงหน้านี้',

    'nav.home': 'หน้าแรก', 'nav.story': 'เนื้อเรื่อง', 'nav.races': 'เผ่าพันธุ์', 'nav.characters': 'ตัวละคร',
    'nav.monsters': 'มอนสเตอร์', 'nav.essences': 'Essence', 'nav.skills': 'สกิล', 'nav.items': 'ไอเทม',
    'nav.maps': 'แผนที่', 'nav.factions': 'กลุ่มอำนาจ', 'nav.lore': 'กฎของโลก', 'nav.label': 'หมวดฐานข้อมูล',

    'cat.races': 'เผ่าพันธุ์', 'cat.characters': 'ตัวละคร', 'cat.monsters': 'มอนสเตอร์', 'cat.essences': 'Essence',
    'cat.skills': 'สกิล', 'cat.items': 'ไอเทม', 'cat.locations': 'สถานที่', 'cat.factions': 'กลุ่มอำนาจ',
    'cat.lore': 'กฎของโลก', 'cat.chapters': 'บท', 'cat.arcs': 'ภาค',
    'one.races': 'เผ่าพันธุ์', 'one.characters': 'ตัวละคร', 'one.monsters': 'มอนสเตอร์', 'one.essences': 'Essence',
    'one.skills': 'สกิล', 'one.items': 'ไอเทม', 'one.locations': 'สถานที่', 'one.factions': 'กลุ่มอำนาจ', 'one.lore': 'กฎของโลก',

    'lede.races': 'เผ่าพันธุ์ในเรื่อง ลักษณะเด่น และความสามารถประจำเผ่าพร้อมตัวอย่างจากเนื้อเรื่อง',
    'lede.characters': 'ตัวละครในเรื่อง เผ่า บทบาท สถานะ Essence ที่มี และไทม์ไลน์พัฒนาการ',
    'lede.monsters': 'มอนสเตอร์ตามเกรด ชั้น และประเภท พร้อมความสามารถ ของดรอป และ Essence ของมัน',
    'lede.essences': 'Essence พร้อมค่าสถานะที่เปลี่ยนไป สกิลติดตัว และสกิลกดใช้ตามสี',
    'lede.skills': 'สกิลจาก Essence เวทมนตร์ ออร่า ความสามารถประจำเผ่า และสกิลของไอเทม',
    'lede.items': 'Numbers Item อุปกรณ์ ของใช้สิ้นเปลือง และวัตถุดิบ',
    'lede.locations': 'สถานที่ทั้งหมดในฐานข้อมูล',
    'lede.factions': 'แคลน กิลด์ ศาสนจักร สมาคมลับ และชาติต่าง ๆ',
    'lede.lore': 'กลไกของโลก: ค่าสถานะ Essence รอยแยก เงินตรา และกฎอื่น ๆ',

    'tile.story': 'ภาคและสรุปรายฉากภาษาไทย', 'tile.races': 'ลักษณะเด่นและความสามารถเผ่า',
    'tile.characters': 'บทบาท Essence ไทม์ไลน์', 'tile.monsters': 'เกรด ชั้น ของดรอป',
    'tile.essences': 'ค่าสถานะและสกิลตามสี', 'tile.skills': 'ผลของสกิล ที่มา ผู้ใช้',
    'tile.items': 'Numbers Item และอุปกรณ์', 'tile.locations': 'ชั้นเขาวงกต โซน เมือง',
    'tile.factions': 'แคลน กิลด์ ศาสนจักร', 'tile.lore': 'กลไกของโลก',

    'home.intro': 'ค้นหาเผ่าพันธุ์ ตัวละคร มอนสเตอร์ Essence สกิล ไอเทม สถานที่ หรือกฎของโลกจากนิยาย ดูว่าแต่ละอย่างปรากฏในบทไหน และอ่านสรุปภาษาไทยของทุกบท ใช้งานได้แบบออฟไลน์ทั้งหมด',
    'home.try': 'ลองค้นหา', 'home.searchBtn': 'ค้นหา', 'home.browse': 'สำรวจฐานข้อมูล', 'home.how': 'วิธีใช้',
    'how.search': 'กด / ที่ไหนก็ได้เพื่อค้นหาทุกหมวดด้วยชื่อภาษาอังกฤษหรือไทย ชื่ออื่น หรือเลขบท แล้วกด Enter เพื่อเปิดผลแรก',
    'how.lists': 'เลือกหมวดจากเมนูด้านบน คลิกหัวคอลัมน์เพื่อเรียงลำดับ และใช้ตัวกรองเหนือตารางเพื่อคัดรายการ',
    'how.links': 'ทุกชื่อคลิกไปหน้ารายละเอียดได้ และท้ายทุกหน้าจะบอกว่าปรากฏในบทใดบ้าง',
    'how.story': 'หน้าเนื้อเรื่องมีสรุปรายฉากภาษาไทยของทุกบท กดลูกศร ← และ → เพื่อเปลี่ยนบท',
    'how.lang': 'สลับภาษาไทยและอังกฤษได้ที่มุมขวาบน ในโหมดภาษาไทยชื่อจะมีชื่ออังกฤษกำกับไว้',
    'home.grades': 'ระดับเกรด', 'home.gradesNote': 'เกรด 9 อ่อนที่สุด เกรด 1 แข็งแกร่งที่สุด มอนสเตอร์ Essence และหินเวทใช้มาตรวัดเดียวกัน',
    'home.colors': 'สีของ Essence', 'home.coverage': 'ขอบเขตข้อมูล',
    'cov.range': 'ช่วงบท', 'cov.missing': 'ไม่มีในต้นฉบับ', 'cov.inDb': 'บทที่มีในฐานข้อมูล', 'cov.sum': 'ตอนที่สรุปแล้ว',
    'cov.version': 'เวอร์ชันข้อมูล', 'cov.generated': 'สร้างเมื่อ', 'cov.have': 'มีในฐานข้อมูล',
    'cov.missLegend': 'ไม่มีในต้นฉบับ', 'cov.none': 'ไม่มี', 'cov.partial': 'ต้นฉบับไม่ครบ',

    'search.placeholder': 'ค้นหาชื่อ ชื่ออื่น หรือเลขบท', 'search.label': 'ค้นหาในฐานข้อมูล',
    'search.cat': 'ค้นหาใน', 'search.all': 'ทุกหมวด', 'search.seeAll': 'ดูผลลัพธ์ทั้งหมดของ “{q}”',
    'search.none': 'ไม่พบผลลัพธ์สำหรับ “{q}”', 'search.title': 'ค้นหา', 'search.results': 'พบ {n} รายการสำหรับ “{q}”',
    'search.results1': 'พบ 1 รายการสำหรับ “{q}”', 'search.prompt': 'พิมพ์ชื่อภาษาอังกฤษหรือภาษาไทย ชื่ออื่น หรือเลขบท',
    'search.inList': 'เปิดเป็นรายการ', 'search.toggle': 'ค้นหา', 'search.capped': 'แสดง {n} รายการที่ตรงที่สุด',
    'search.hintKey': 'กด / เพื่อค้นหา', 'search.noChapter': 'ยังไม่มีในฐานข้อมูล',

    'theme.toLight': 'เปลี่ยนเป็นธีมสว่าง', 'theme.toDark': 'เปลี่ยนเป็นธีมมืด',
    'lang.label': 'ภาษา: {l}', 'lang.en': 'อังกฤษ', 'lang.th': 'ไทย',

    'list.search': 'ค้นหาในรายการนี้', 'list.searchPh': 'ชื่อ ชื่อไทย หรือชื่ออื่น', 'list.any': 'ทั้งหมด',
    'list.clear': 'ล้างตัวกรอง', 'list.count': '{n} รายการ', 'list.count1': '1 รายการ',
    'list.countOf': 'ตรงเงื่อนไข {n} จาก {total} รายการ', 'list.showing': 'แสดง {a}–{b}',
    'list.emptyFiltered': 'ไม่มีรายการที่ตรงกับตัวกรองนี้', 'list.emptyNone': 'ยังไม่มีข้อมูล{cat}ในฐานข้อมูล',
    'list.prev': 'ก่อนหน้า', 'list.next': 'ถัดไป', 'list.pages': 'หน้า', 'list.sortHint': 'คลิกหัวคอลัมน์เพื่อเรียงลำดับ',
    'list.mapLink': 'ดูผังสถานที่และแผนภาพเขาวงกตได้ที่หน้าแผนที่',

    'col.name': 'ชื่อ', 'col.title': 'ชื่อเรื่อง', 'col.grade': 'เกรด', 'col.category': 'ประเภท', 'col.floors': 'ชั้น',
    'col.floor': 'ชั้น', 'col.zones': 'โซน', 'col.essence': 'Essence', 'col.monster': 'มอนสเตอร์', 'col.colors': 'สี',
    'col.stats': 'ค่าสถานะ', 'col.users': 'ผู้ใช้', 'col.kind': 'ชนิด', 'col.source': 'ที่มา', 'col.cost': 'ค่าใช้',
    'col.cooldown': 'คูลดาวน์', 'col.number': 'หมายเลข', 'col.material': 'วัสดุ', 'col.price': 'ราคา', 'col.owners': 'ผู้ครอบครอง',
    'col.race': 'เผ่า', 'col.roles': 'บทบาท', 'col.status': 'สถานะ', 'col.importance': 'ความสำคัญ', 'col.evil': 'วิญญาณร้าย',
    'col.first': 'บทแรก', 'col.chapters': 'จำนวนบท', 'col.parent': 'อยู่ใน', 'col.monsters': 'มอนสเตอร์',
    'col.leader': 'ผู้นำ', 'col.members': 'สมาชิก', 'col.topic': 'หัวข้อ', 'col.abilities': 'ความสามารถเผ่า',
    'col.people': 'ตัวละคร',

    'f.grade': 'เกรด', 'f.floor': 'ชั้น', 'f.category': 'ประเภท', 'f.color': 'สี', 'f.hasUser': 'ผู้ใช้',
    'f.kind': 'ชนิด', 'f.source': 'ประเภทที่มา', 'f.numbered': 'Numbers Item', 'f.race': 'เผ่า',
    'f.importance': 'ความสำคัญ', 'f.status': 'สถานะ', 'f.evil': 'วิญญาณร้าย', 'f.topic': 'หัวข้อ',
    'opt.yes': 'ใช่', 'opt.no': 'ไม่ใช่', 'opt.hasUsers': 'มีผู้ใช้', 'opt.noUsers': 'ไม่มีผู้ใช้',
    'opt.numbered': 'มีหมายเลข', 'opt.notNumbered': 'ไม่มีหมายเลข', 'opt.unknown': 'ไม่ทราบ',

    'imp.1': 'ตัวหลัก', 'imp.2': 'ตัวรอง', 'imp.3': 'ตัวประกอบ',
    'grade.n': 'เกรด {n}', 'grade.weakest': 'อ่อนที่สุด', 'grade.strongest': 'แข็งแกร่งที่สุด',
    'floor.n': 'ชั้น {n}', 'floor.ug': 'ชั้นใต้ดิน {n}',
    'ch.short': 'บท {n}',
    'yes': 'ใช่', 'no': 'ไม่ใช่', 'unknown': 'ไม่ทราบ',
    'ref.missing': 'ยังไม่มีในฐานข้อมูล',
    'tag.en': 'ยังไม่มีข้อความภาษาไทย จึงแสดงภาษาอังกฤษแทน',

    'lbl.aliases': 'ชื่ออื่น', 'lbl.id': 'รหัส (ID)', 'lbl.first': 'ปรากฏครั้งแรก', 'lbl.grade': 'เกรด',
    'lbl.category': 'ประเภท', 'lbl.floors': 'ชั้น', 'lbl.zones': 'โซน', 'lbl.essence': 'Essence',
    'lbl.monster': 'มอนสเตอร์', 'lbl.madeFrom': 'สังเคราะห์จาก', 'lbl.colors': 'สี', 'lbl.users': 'ผู้ใช้', 'lbl.kind': 'ชนิด', 'lbl.source': 'ที่มา',
    'lbl.cost': 'ค่าใช้', 'lbl.cooldown': 'คูลดาวน์', 'lbl.number': 'หมายเลข', 'lbl.material': 'วัสดุ',
    'lbl.price': 'ราคา', 'lbl.race': 'เผ่าพันธุ์', 'lbl.gender': 'เพศ', 'lbl.roles': 'บทบาท',
    'lbl.affiliations': 'สังกัด', 'lbl.status': 'สถานะ', 'lbl.evil': 'วิญญาณร้าย', 'lbl.mask': 'หน้ากากโต๊ะกลม',
    'lbl.importance': 'ความสำคัญ', 'lbl.parent': 'อยู่ใน', 'lbl.path': 'ตำแหน่ง', 'lbl.floor': 'ชั้น',
    'lbl.leader': 'ผู้นำ', 'lbl.members': 'สมาชิก', 'lbl.topic': 'หัวข้อ', 'lbl.owners': 'ผู้ครอบครอง',
    'lbl.notable': 'บุคคลสำคัญ', 'lbl.people': 'ตัวละคร', 'lbl.monsters': 'มอนสเตอร์',
    'lbl.inside': 'สถานที่ย่อย', 'lbl.chapters': 'จำนวนบท', 'lbl.infobox': 'ข้อมูลโดยย่อ',

    'sec.summary': 'สรุป', 'sec.appearance': 'รูปลักษณ์', 'sec.abilities': 'ความสามารถ', 'sec.weakness': 'จุดอ่อน',
    'sec.behavior': 'พฤติกรรม', 'sec.drops': 'ของดรอป', 'sec.essence': 'Essence', 'sec.encounters': 'การเผชิญหน้า',
    'sec.stats': 'ค่าสถานะ', 'sec.passive': 'สกิลติดตัว (Passive)', 'sec.actives': 'สกิลกดใช้ตามสี',
    'sec.activeShort': 'สกิลกดใช้', 'sec.users': 'ผู้ใช้', 'sec.personality': 'นิสัย',
    'sec.essences': 'Essence ที่มี', 'sec.skills': 'สกิล', 'sec.items': 'ไอเทม', 'sec.relationships': 'ความสัมพันธ์',
    'sec.timeline': 'ไทม์ไลน์พัฒนาการ', 'sec.traits': 'ลักษณะเด่น', 'sec.raceAbilities': 'ความสามารถประจำเผ่า',
    'sec.roles': 'บทบาทที่พบบ่อย', 'sec.culture': 'วัฒนธรรม', 'sec.homeland': 'ถิ่นกำเนิด', 'sec.notable': 'บุคคลสำคัญ',
    'sec.raceMembers': 'ตัวละครในเผ่านี้', 'sec.description': 'คำอธิบาย', 'sec.effects': 'ผลของไอเทม',
    'sec.owners': 'ผู้ครอบครอง', 'sec.obtained': 'วิธีได้มา', 'sec.features': 'จุดเด่นของพื้นที่', 'sec.rules': 'กฎของพื้นที่',
    'sec.inside': 'สถานที่ย่อย', 'sec.monstersHere': 'มอนสเตอร์ที่พบ', 'sec.members': 'สมาชิก',
    'sec.body': 'รายละเอียด', 'sec.appears': 'ปรากฏในบท', 'sec.skillUsers': 'ตัวละครที่มีสกิลนี้',
    'sec.source': 'ที่มา',

    'th.ability': 'ความสามารถ', 'th.effect': 'ผล', 'th.stat': 'ค่าสถานะ', 'th.value': 'ค่า', 'th.colour': 'สี',
    'th.skill': 'สกิล', 'th.trans': 'Transcendence', 'th.character': 'ตัวละคร', 'th.chapter': 'บท',
    'th.note': 'หมายเหตุ', 'th.acquired': 'ได้รับในบท', 'th.relation': 'ความสัมพันธ์', 'th.what': 'สิ่งที่เกิดขึ้น',
    'th.kind': 'ชนิด', 'th.source': 'ที่มา', 'th.item': 'ไอเทม', 'th.number': 'หมายเลข', 'th.category': 'ประเภท',
    'th.grade': 'เกรด', 'th.name': 'ชื่อ', 'th.race': 'เผ่า', 'th.roles': 'บทบาท', 'th.status': 'สถานะ',
    'th.essence': 'Essence', 'th.monster': 'มอนสเตอร์',

    'appears.none': 'ยังไม่มีการบันทึกบทที่ปรากฏ', 'appears.summary': '{n} บท ตั้งแต่บทที่ {a} ถึงบทที่ {b}',
    'appears.one': '1 บท', 'appears.more': 'แสดงอีก {n} บท',

    'story.title': 'เนื้อเรื่อง', 'story.lede': 'นิยายแบ่งตามภาค ทุกบทมีสรุปย่อภาษาไทยและอังกฤษ พร้อมสรุปรายฉากภาษาไทย',
    'story.ribbon': 'ภาคต่าง ๆ ตลอดบทที่ 1–{total}', 'story.noArcs': 'ยังไม่มีข้อมูลภาค',
    'story.orphans': 'บทที่ยังไม่ระบุภาค', 'story.coverage': 'มีในฐานข้อมูล {have} จาก {total} บท',
    'arc.n': 'ภาค {n}', 'arc.range': 'บทที่ {a}–{b}', 'arc.subarcs': 'ช่วงเรื่องย่อย', 'arc.chapters': 'บท',
    'arc.coverage': 'มีสรุปแล้ว {have} จาก {total} บท', 'arc.other': 'บทอื่น ๆ',
    'arc.notFound': 'ไม่พบภาคที่มีรหัส “{id}”', 'arc.noChapters': 'ยังไม่มีบทของภาคนี้ในฐานข้อมูล',
    'arc.colTitle': 'ช่วงเรื่อง', 'arc.colTh': 'ชื่อไทย', 'arc.colRange': 'บท', 'arc.colHave': 'มีในฐานข้อมูล',

    'ch.title': 'บทที่ {n}', 'ch.arc': 'ภาค', 'ch.subarc': 'ช่วงเรื่อง', 'ch.setting': 'ฉาก', 'ch.chars': 'ตัวละคร',
    'ch.tldr': 'สรุปย่อ', 'ch.scenes': 'สรุปรายฉาก', 'ch.thaiNote': 'สรุปรายฉากเขียนเป็นภาษาไทย',
    'ch.loading': 'กำลังโหลดสรุปรายฉาก…', 'ch.noStory': 'ยังไม่มีสรุปรายฉากของบทนี้',
    'ch.fileMissing': 'โหลดไฟล์ {file} ไม่ได้ สรุปรายฉากของภาคนี้จึงหายไป',
    'ch.prev': 'บทก่อนหน้า', 'ch.next': 'บทถัดไป', 'ch.jump': 'ไปที่บท', 'ch.go': 'ไป',
    'ch.missingSrc': 'บทที่ {n} ไม่มีอยู่ในต้นฉบับ การนับเลขบทเดิมข้ามบทนี้ไป',
    'ch.notInDb': 'ยังไม่มีข้อมูลบทที่ {n} ในฐานข้อมูล',
    'ch.partialSrc': 'ไฟล์ต้นฉบับของบทที่ {n} ไม่ครบ (มีราว {have} จาก {total} คำ) สรุปและข้อมูลของบทนี้จึงครอบคลุมแค่ช่วงต้นของตอน',
    'ch.outOfRange': 'ไม่มีบทที่ {n} นิยายมีตั้งแต่บทที่ 1 ถึงบทที่ {total}',
    'ch.inThis': 'ข้อมูลอื่นที่ปรากฏในบทนี้', 'ch.keys': 'เคล็ดลับ: กดปุ่ม ← และ → เพื่อเปลี่ยนบท',

    'maps.title': 'แผนที่', 'maps.lede': 'เขาวงกตทีละชั้น และสถานที่ทั้งหมดเรียงตามพื้นที่ที่ครอบอยู่',
    'maps.lab': 'เขาวงกต', 'maps.tree': 'ผังสถานที่ทั้งหมด', 'maps.table': 'เปิดตารางสถานที่',
    'maps.expand': 'ขยายทั้งหมด', 'maps.collapse': 'ย่อทั้งหมด', 'maps.noZones': 'ยังไม่มีข้อมูลโซน',
    'maps.mon': 'มอนสเตอร์ {n} ชนิด', 'maps.mon1': 'มอนสเตอร์ 1 ชนิด', 'maps.mon0': 'ยังไม่มีมอนสเตอร์',
    'maps.legend.zone': 'โซน', 'maps.legend.rift': 'รอยแยก', 'maps.legend.hidden': 'ฟิลด์ลับ', 'maps.legend.island': 'เกาะ',
    'maps.underground': 'ชั้นใต้ดิน', 'maps.noLoc': 'ยังไม่มีข้อมูลสถานที่',
    'maps.top': 'ชั้น 1 อยู่บนสุด ยิ่งลึกแถบของชั้นยิ่งมืดลง',
    'maps.noFloors': 'ยังไม่มีข้อมูลชั้นของเขาวงกต', 'maps.floorMissing': 'ยังไม่มีหน้าของชั้นนี้',

    'nf.title': 'ไม่พบหน้านี้', 'nf.body': 'ไม่มีหน้าที่อยู่ “{h}”', 'nf.entity': 'ไม่พบ{what}ที่มีรหัส “{id}”',
    'nf.similar': 'ชื่อที่ใกล้เคียง', 'nf.back': 'กลับไปที่{cat}', 'nf.home': 'ไปหน้าแรก',

    'foot.about': 'ฐานข้อมูลออฟไลน์ที่แฟนจัดทำ สำหรับนิยาย Surviving the Game as a Barbarian',
    'foot.data': 'ข้อมูลเวอร์ชัน {v}', 'foot.generated': 'สร้างเมื่อ {d}', 'foot.check': 'ตรวจข้อมูล',

    'check.title': 'ตรวจสอบข้อมูล', 'check.lede': 'สำหรับทีมข้อมูล: ปัญหาที่พบในไฟล์ data/db.js ให้แก้ที่ข้อมูลต้นทางแล้วสร้างไฟล์ใหม่ (เว็บไซต์ยังทำงานได้แม้มีปัญหาเหล่านี้)',
    'check.counts': 'จำนวนรายการแต่ละหมวด', 'check.dupes': 'รหัสซ้ำ (ใช้เฉพาะรายการแรก)',
    'check.noId': 'รายการที่ไม่มีรหัส (ถูกละไว้)', 'check.unres': 'การอ้างอิงด้วยรหัสที่หาไม่พบ',
    'check.unresNote': 'ค่าที่เขียนแบบรหัส (ตัวพิมพ์เล็กคั่นด้วยขีด) แต่ไม่ตรงกับรายการใด เว็บไซต์จะแสดงเป็นข้อความธรรมดา',
    'check.free': 'การอ้างอิงแบบข้อความ', 'check.freeNote': 'ชื่อที่ไม่ใช่รหัสและไม่ตรงกับรายการ ชื่อ หรือชื่ออื่นใด ใช้ได้ แต่จะแสดงเป็นข้อความธรรมดา',
    'check.chapters': 'บท', 'check.noMeta': 'เลขบทที่ยังไม่มีใน DB.chapters',
    'check.badArc': 'บทที่อ้างถึงรหัสภาคที่ไม่มีอยู่', 'check.story': 'ไฟล์เนื้อเรื่อง',
    'check.storyBtn': 'โหลดและตรวจไฟล์เนื้อเรื่องทั้งหมด', 'check.storyOk': '{arc}: มีสรุป {n} บท',
    'check.storyMissing': '{arc}: ไม่พบไฟล์ data/story/{arc}.js หรือไฟล์เสีย', 'check.storyGaps': '{arc}: บทที่ยังไม่มีสรุป {list}',
    'check.ok': 'ไม่พบปัญหา', 'check.field': 'ฟิลด์', 'check.value': 'ค่า', 'check.entry': 'รายการ',
    'check.count': 'จำนวน', 'check.andMore': '…และอีก {n} รายการ',

    'color.red': 'แดง', 'color.orange': 'ส้ม', 'color.yellow': 'เหลือง', 'color.green': 'เขียว', 'color.blue': 'น้ำเงิน',
    'color.indigo': 'คราม', 'color.purple': 'ม่วง', 'color.black': 'ดำ', 'color.white': 'ขาว', 'color.gold': 'ทอง',
    'color.silver': 'เงิน', 'color.rainbow': 'รุ้ง', 'color.pink': 'ชมพู', 'color.brown': 'น้ำตาล', 'color.grey': 'เทา',
    'color.unknown': 'ไม่ทราบสี',
  };

  /** Thai labels for enum-like data values (kinds, categories, statuses…).
   *  Keys are lower case. Unknown values are shown as written (first letter capitalised). */
  const ENUM_TH = {
    // monster categories
    'normal': 'ปกติ', 'elite': 'อีลีท', 'variant': 'สายพันธุ์กลาย', 'named': 'เนมด์', 'boss': 'บอส',
    'rift guardian': 'ผู้พิทักษ์รอยแยก', 'guardian': 'ผู้พิทักษ์', 'field boss': 'ฟิลด์บอส', 'floor lord': 'เจ้าแห่งชั้น',
    'hidden boss': 'บอสลับ', 'summon': 'สิ่งอัญเชิญ', 'mid-boss': 'มิดบอส', 'other': 'อื่น ๆ',
    // skill kinds and source types
    'essence active': 'สกิลกดใช้ (Essence)', 'essence passive': 'สกิลติดตัว (Essence)', 'spell': 'เวทมนตร์',
    'aura': 'ออร่า', 'divine': 'พลังศักดิ์สิทธิ์', 'dragon word': 'ภาษามังกร', 'spirit': 'วิญญาณ/ภูต',
    'tattoo/imprint': 'รอยสัก/ตราวิญญาณ', 'racial': 'สกิลประจำเผ่า', 'item skill': 'สกิลไอเทม',
    'class technique': 'เทคนิคสายอาชีพ', 'curse': 'คำสาป',
    'essence': 'Essence', 'race': 'เผ่าพันธุ์', 'item': 'ไอเทม', 'class': 'สายอาชีพ', 'character': 'ตัวละคร', 'monster': 'มอนสเตอร์',
    // item categories
    'numbers item': 'Numbers Item', 'weapon': 'อาวุธ', 'armor': 'ชุดเกราะ', 'armour': 'ชุดเกราะ', 'shield': 'โล่',
    'accessory': 'เครื่องประดับ', 'consumable': 'ของใช้สิ้นเปลือง', 'potion': 'โพชั่น', 'material': 'วัตถุดิบ',
    'magic tool': 'เครื่องมือเวท', 'artifact': 'อาร์ติแฟกต์', 'quest item': 'ไอเทมเควสต์', 'currency': 'เงินตรา',
    // location kinds
    'world': 'โลก', 'continent': 'ทวีป', 'city': 'เมือง', 'district': 'เขต', 'building': 'อาคาร',
    'labyrinth floor': 'ชั้นเขาวงกต', 'zone': 'โซน', 'rift': 'รอยแยก', 'hidden field': 'ฟิลด์ลับ', 'island': 'เกาะ',
    'region': 'ภูมิภาค', 'country': 'ประเทศ', 'dungeon': 'ดันเจียน', 'landmark': 'สถานที่สำคัญ', 'realm': 'แดน',
    // faction kinds
    'royal family': 'ราชวงศ์', 'clan': 'แคลน', 'guild': 'กิลด์', 'church/religion': 'ศาสนจักร', 'church': 'ศาสนจักร',
    'religion': 'ศาสนา', 'secret society': 'สมาคมลับ', 'criminal': 'องค์กรอาชญากรรม', 'nation': 'ชาติ',
    'tribe': 'เผ่า', 'military': 'กองทัพ', 'team': 'ทีม', 'party': 'ปาร์ตี้',
    // character status and gender
    'alive': 'มีชีวิต', 'dead': 'เสียชีวิต', 'deceased': 'เสียชีวิต', 'missing': 'สูญหาย', 'unknown': 'ไม่ทราบ',
    'sealed': 'ถูกผนึก', 'retired': 'เกษียณ', 'imprisoned': 'ถูกจองจำ', 'male': 'ชาย', 'female': 'หญิง',
    // common lore topics
    'stats': 'ค่าสถานะ', 'monsters': 'มอนสเตอร์', 'items': 'ไอเทม', 'rifts': 'รอยแยก', 'evil spirits': 'วิญญาณร้าย',
    'levels & exp': 'เลเวลและ EXP', 'explorer rank': 'แรงก์นักสำรวจ', 'essence absorption rules': 'กฎการดูดซับ Essence',
    'mana stones': 'หินเวท', 'numbers items': 'Numbers Item', 'records/achievements': 'บันทึก (Records)',
    'hidden pieces': 'Hidden Piece', 'soul power': 'Soul Power', 'history': 'ประวัติศาสตร์',
    'game vs reality': 'เกมกับความจริง', 'labyrinth rules': 'กฎของเขาวงกต',
  };

  /** English display overrides where plain capitalisation is wrong (game terms). */
  const ENUM_EN = {
    'numbers item': 'Numbers Item', 'numbers items': 'Numbers Items', 'floor lord': 'Floor Lord',
    'soul power': 'Soul Power', 'levels & exp': 'Levels & EXP', 'hidden pieces': 'Hidden Pieces', 'hidden piece': 'Hidden Piece',
  };

  let lang = 'en';
  let collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

  /** UI string in the current language, with {var} substitution. */
  /* v2 strings: sections, stages, EXP/drops, grouped timelines, level strip, "+N more", contents. */
  Object.assign(I18N.en, {
    'sec.history': 'Timeline', 'sec.levels': 'Level progression', 'sec.stages': 'Stages',
    'sec.raceFeats': 'Racial feats observed (by chapter)', 'feats.count': '{n} observations',
    'lbl.exp': 'EXP (first kill)', 'lbl.level': 'Level', 'col.exp': 'EXP',
    'f.drops': 'Drops', 'opt.hasDrops': 'Has drops', 'opt.noDrops': 'No drops',
    'th.stage': 'Stage', 'th.revealed': 'Revealed', 'th.costCond': 'Cost / condition', 'th.drop': 'Item',
    'skill.stages': '{n} stages', 'skill.stage1': '1 stage', 'lvl.n': 'Lv {n}',
    'more.n': '+{n} more', 'more.less': 'Show less',
    'tl.count': '{n} entries, grouped by arc', 'tl.noArc': 'Other chapters', 'tl.undated': 'No chapter',
    'toc.title': 'On this page',
  });
  Object.assign(I18N.th, {
    'sec.history': 'ไทม์ไลน์', 'sec.levels': 'พัฒนาการเลเวล', 'sec.stages': 'ขั้นของสกิล',
    'sec.raceFeats': 'ความสามารถของเผ่าที่ปรากฏ (เรียงตามบท)', 'feats.count': '{n} เหตุการณ์',
    'lbl.exp': 'EXP (ฆ่าครั้งแรก)', 'lbl.level': 'เลเวล', 'col.exp': 'EXP',
    'f.drops': 'ของดรอป', 'opt.hasDrops': 'มีของดรอป', 'opt.noDrops': 'ไม่มีของดรอป',
    'th.stage': 'ขั้น', 'th.revealed': 'เปิดเผยในบท', 'th.costCond': 'ค่าใช้ / เงื่อนไข', 'th.drop': 'ไอเทม',
    'skill.stages': '{n} ขั้น', 'skill.stage1': '1 ขั้น', 'lvl.n': 'Lv {n}',
    'more.n': '+อีก {n}', 'more.less': 'ย่อ',
    'tl.count': '{n} รายการ แบ่งตามภาค', 'tl.noArc': 'บทอื่น ๆ', 'tl.undated': 'ไม่ระบุบท',
    'toc.title': 'ในหน้านี้',
  });

  function T(key, vars) {
    let s = I18N[lang] && I18N[lang][key];
    if (s == null) s = I18N.en[key];
    if (s == null) return key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return s;
  }
  /** Display label for an enum-like data value ("labyrinth floor" -> "Labyrinth floor" / "ชั้นเขาวงกต"). */
  function enumLabel(v) {
    if (v == null || String(v).trim() === '') return '';
    const s = String(v).trim();
    const k = s.toLowerCase();
    if (lang === 'th' && ENUM_TH[k]) return ENUM_TH[k];
    return ENUM_EN[k] || cap(s);
  }

  /* =================================================================
   * 3. Data — normalise window.DB once and build lookup indexes.
   *    The app never crashes on missing fields or unknown ids: every
   *    array is optional, references that do not resolve show as text.
   * ================================================================= */
  const CATS = ['races', 'characters', 'monsters', 'essences', 'skills', 'items', 'locations', 'factions', 'lore'];
  /** Detail route segment per category: #/monster/<id>, #/lore/<id> … */
  const SINGULAR = { races: 'race', characters: 'character', monsters: 'monster', essences: 'essence', skills: 'skill',
    items: 'item', locations: 'location', factions: 'faction', lore: 'lore' };
  const FROM_SINGULAR = {};
  CATS.forEach((c) => { FROM_SINGULAR[SINGULAR[c]] = c; });
  /** Which top-nav item lights up for a category. */
  const NAV_OF = { races: 'races', characters: 'characters', monsters: 'monsters', essences: 'essences', skills: 'skills',
    items: 'items', locations: 'maps', factions: 'factions', lore: 'lore' };
  /** Lookup order when a reference could point at any category. */
  const ANY = ['characters', 'monsters', 'essences', 'items', 'skills', 'locations', 'factions', 'races', 'lore'];

  const HAS_DB = !!(window.DB && typeof window.DB === 'object');
  const SRC = HAS_DB ? window.DB : {};
  const D = {};          // normalised arrays: D.monsters …, D.arcs, D.chapters, D.meta
  const BY_ID = {};      // cat -> Map(id -> entity)
  const BY_NAME = {};    // cat -> Map(normalised name / Thai name / alias -> entity)
  const ISSUES = { dupes: [], noId: [] };
  const R = {};          // derived relations, see buildRelations()
  let CH_BY_N = new Map();
  let CH_NUMS = [];
  let ARC_BY_ID = new Map();

  function normRefs(x) {
    const out = [];
    for (const v of arr(x)) { const n = toInt(v); if (n != null && n > 0) out.push(n); }
    out.sort((a, b) => a - b);
    return out.filter((n, i) => i === 0 || out[i - 1] !== n);
  }
  function normRange(r) {
    if (!Array.isArray(r) || r.length < 2) return null;
    const a = toInt(r[0]), b = toInt(r[1]);
    if (a == null || b == null) return null;
    return a <= b ? [a, b] : [b, a];
  }
  const nameKeys = (e) => [e.name, e.name_th, e.title, e.title_th].concat(arr(e.aliases)).map(norm).filter(Boolean);

  function prepareData() {
    for (const cat of CATS) {
      const list = Array.isArray(SRC[cat]) ? SRC[cat] : [];
      const byId = new Map(), byName = new Map(), ok = [];
      for (const e of list) {
        if (!e || typeof e !== 'object' || e.id == null || String(e.id).trim() === '') { ISSUES.noId.push({ cat, e }); continue; }
        e.id = String(e.id).trim();
        if (byId.has(e.id)) { ISSUES.dupes.push({ cat, id: e.id }); continue; }
        e.refs = normRefs(e.refs);
        byId.set(e.id, e);
        ok.push(e);
      }
      for (const e of ok) for (const k of nameKeys(e)) if (!byName.has(k)) byName.set(k, e);
      D[cat] = ok; BY_ID[cat] = byId; BY_NAME[cat] = byName;
    }
    const m = SRC.meta && typeof SRC.meta === 'object' ? SRC.meta : {};
    D.meta = Object.assign({}, m, {
      chapters_total: toInt(m.chapters_total) || 941,
      chapters_missing: normRefs(m.chapters_missing),
      chapters_partial: arr(m.chapters_partial).map((x) => (x && typeof x === 'object' ? x : { n: x }))
        .filter((x) => toInt(x.n) != null).map((x) => ({ n: toInt(x.n), have: toInt(x.have), total: toInt(x.total) })),
    });

    D.arcs = (Array.isArray(SRC.arcs) ? SRC.arcs : [])
      .filter((a) => a && typeof a === 'object' && a.id != null && String(a.id).trim() !== '')
      .map((a) => Object.assign({}, a, {
        id: String(a.id).trim(), n: toInt(a.n), range: normRange(a.range),
        subarcs: arr(a.subarcs).filter((s) => s && typeof s === 'object')
          .map((s) => Object.assign({}, s, { range: normRange(s.range) })),
      }));
    D.arcs.sort((x, y) => ((x.n == null ? 1e9 : x.n) - (y.n == null ? 1e9 : y.n))
      || ((x.range ? x.range[0] : 1e9) - (y.range ? y.range[0] : 1e9)));
    ARC_BY_ID = new Map(D.arcs.map((a) => [a.id, a]));

    const seen = new Set();
    D.chapters = (Array.isArray(SRC.chapters) ? SRC.chapters : [])
      .filter((c) => c && typeof c === 'object' && toInt(c.n) != null && toInt(c.n) > 0)
      .map((c) => Object.assign({}, c, { n: toInt(c.n) }))
      .filter((c) => { if (seen.has(c.n)) return false; seen.add(c.n); return true; })
      .sort((a, b) => a.n - b.n);
    CH_BY_N = new Map(D.chapters.map((c) => [c.n, c]));
    CH_NUMS = D.chapters.map((c) => c.n);
    buildRelations();
  }

  const resolveCache = new Map();
  /** Find the entity a reference points to. Tries, per category in order:
   *  exact id, then exact name / Thai name / alias, then the slug of the text.
   *  Accepts {id, name} objects. Returns {cat, e} or null. */
  function resolve(value, cats) {
    if (value == null) return null;
    if (typeof value === 'object') return resolve(value.id, cats) || resolve(value.name, cats);
    const s = String(value).trim();
    if (!s) return null;
    const list = cats || ANY;
    const ck = list.join(',') + '|' + s;
    if (resolveCache.has(ck)) return resolveCache.get(ck);
    let hit = null;
    for (const c of list) { const e = BY_ID[c] && BY_ID[c].get(s); if (e) { hit = { cat: c, e }; break; } }
    if (!hit) {
      const k = norm(s);
      for (const c of list) { const e = BY_NAME[c] && BY_NAME[c].get(k); if (e) { hit = { cat: c, e }; break; } }
    }
    if (!hit) {
      const sl = slug(s);
      if (sl && sl !== s) for (const c of list) { const e = BY_ID[c] && BY_ID[c].get(sl); if (e) { hit = { cat: c, e }; break; } }
    }
    resolveCache.set(ck, hit);
    return hit;
  }
  const resolveE = (value, cat) => { const r = resolve(value, [cat]); return r ? r.e : null; };

  /* ---------- Labyrinth floors ----------
   * Floors are strings in the data ("1", "Floor 3", "Underground 1").
   * floorKey() turns them into "1" … "10" for normal floors and "u1" … for
   * underground floors, so every spelling groups together. */
  function floorKey(f) {
    if (f == null || f === '') return '';
    const s = String(f).trim().toLowerCase();
    const d = s.match(/\d+/);
    if (d && /under|basement|^b\s*\d|^u\s*\d/.test(s)) return 'u' + parseInt(d[0], 10);
    if (d && /^(floor\s*)?\d+(st|nd|rd|th)?(\s*(f|floor))?$/.test(s)) return String(parseInt(d[0], 10));
    return s;
  }
  function floorLabel(f) {
    const k = floorKey(f);
    if (/^\d+$/.test(k)) return T('floor.n', { n: k });
    if (/^u\d+$/.test(k)) return T('floor.ug', { n: k.slice(1) });
    return String(f == null ? '' : f);
  }
  const floorOrder = (k) => (/^\d+$/.test(k) ? +k : /^u\d+$/.test(k) ? 1000 + +k.slice(1) : 5000);
  const isFloorKind = (kind) => /floor/i.test(String(kind || ''));
  const KIND_ORDER = ['world', 'continent', 'country', 'region', 'realm', 'city', 'district', 'building', 'dungeon',
    'labyrinth floor', 'zone', 'hidden field', 'rift', 'island', 'landmark'];
  const kindRank = (k) => { const i = KIND_ORDER.indexOf(String(k || '').toLowerCase()); return i < 0 ? 99 : i; };

  /** Every derived relation is built here, once. */
  function buildRelations() {
    const push = (map, key, v) => { if (!map.has(key)) map.set(key, []); map.get(key).push(v); };
    const add = (map, key, v) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(v); };

    // Location tree. Unknown or self parents make a root; cycles are broken below.
    R.parentOf = new Map(); R.children = new Map(); R.roots = [];
    for (const l of D.locations) {
      const p = l.parent != null && l.parent !== '' ? resolveE(l.parent, 'locations') : null;
      if (p && p !== l) { R.parentOf.set(l.id, p); push(R.children, p.id, l); } else R.roots.push(l);
    }
    const reach = new Set();
    const walk = (l) => { if (reach.has(l.id)) return; reach.add(l.id); (R.children.get(l.id) || []).forEach(walk); };
    R.roots.forEach(walk);
    for (const l of D.locations) if (!reach.has(l.id)) { R.roots.push(l); R.parentOf.delete(l.id); walk(l); }

    // Floor pages: the first "… floor" location for each floor key.
    R.floorLoc = new Map();
    for (const l of D.locations) { const k = floorKey(l.floor); if (k && isFloorKind(l.kind) && !R.floorLoc.has(k)) R.floorLoc.set(k, l); }

    // Monsters per location and per floor (from monster.zones/floors and location.monsters).
    R.monByLoc = new Map(); R.monByFloor = new Map();
    for (const m of D.monsters) {
      for (const z of arr(m.zones)) {
        const l = resolveE(z, 'locations');
        if (l) { add(R.monByLoc, l.id, m); const k = floorKey(locFloor(l)); if (k) add(R.monByFloor, k, m); }
      }
      for (const f of arr(m.floors)) { const k = floorKey(f); if (k) add(R.monByFloor, k, m); }
    }
    for (const l of D.locations) for (const id of arr(l.monsters)) {
      const m = resolveE(id, 'monsters');
      if (m) { add(R.monByLoc, l.id, m); const k = floorKey(locFloor(l)); if (k) add(R.monByFloor, k, m); }
    }

    // Essence <-> monster (the monster's own "essence" field wins).
    R.essOfMon = new Map(); R.monOfEss = new Map();
    for (const es of D.essences) {
      const m = es.monster ? resolveE(es.monster, 'monsters') : null;
      if (m) { R.monOfEss.set(es.id, m); if (!R.essOfMon.has(m.id)) R.essOfMon.set(m.id, es); }
    }
    for (const m of D.monsters) {
      const es = m.essence ? resolveE(m.essence, 'essences') : null;
      if (es) { R.essOfMon.set(m.id, es); if (!R.monOfEss.has(es.id)) R.monOfEss.set(es.id, m); }
    }

    // Back-references from characters (so data written on one side shows on both).
    R.charsByRace = new Map(); R.charsByFaction = new Map(); R.essHolders = new Map();
    R.skillUsers = new Map(); R.itemOwners = new Map();
    for (const c of D.characters) {
      const r = c.race ? resolveE(c.race, 'races') : null;
      if (r) push(R.charsByRace, r.id, c);
      for (const a of arr(c.affiliations)) { const f = resolveE(a, 'factions'); if (f) push(R.charsByFaction, f.id, c); }
      for (const x of arr(c.essences)) {
        const o = typeof x === 'object' ? x : { essence: x };
        const es = o && resolveE(o.essence, 'essences');
        if (es) push(R.essHolders, es.id, { who: c.id, ch: o.ch, note: o.note });
      }
      for (const s of arr(c.skills)) { const sk = resolveE(s, 'skills'); if (sk) push(R.skillUsers, sk.id, c); }
      for (const it of arr(c.items)) { const i = resolveE(it, 'items'); if (i) push(R.itemOwners, i.id, c); }
    }

    // Skills by (source id + name), used to link skill names on essence pages.
    R.skillBySrc = new Map();
    for (const s of D.skills) {
      const src = s.source && typeof s.source === 'object' ? s.source : {};
      const key = String(src.id || '') + '|' + norm(s.name);
      if (!R.skillBySrc.has(key)) R.skillBySrc.set(key, s);
    }
  }

  /** The floor a location is on: its own "floor" or the nearest ancestor's. */
  const locFloor = memo((l) => {
    let cur = l, guard = 0;
    while (cur && guard++ < 40) {
      if (cur.floor != null && String(cur.floor).trim() !== '') return String(cur.floor);
      cur = R.parentOf.get(cur.id);
    }
    return '';
  });
  function ancestors(l) {
    const out = [], seen = new Set([l.id]);
    let cur = R.parentOf.get(l.id);
    while (cur && !seen.has(cur.id)) { out.unshift(cur); seen.add(cur.id); cur = R.parentOf.get(cur.id); }
    return out;
  }
  function descendants(l) {
    const out = [], seen = new Set([l.id]);
    const walk = (x) => (R.children.get(x.id) || []).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); walk(c); } });
    walk(l);
    return out;
  }
  function sortLocs(list) {
    return list.slice().sort((a, b) => {
      const fa = isFloorKind(a.kind) ? floorOrder(floorKey(a.floor)) : 1e6;
      const fb = isFloorKind(b.kind) ? floorOrder(floorKey(b.floor)) : 1e6;
      return (fa - fb) || (kindRank(a.kind) - kindRank(b.kind)) || collator.compare(plainName(a), plainName(b));
    });
  }
  /** Monsters at a location (directly, or anywhere on the floor for a floor page). */
  const monstersAt = memo((l) => {
    const s = new Set(R.monByLoc.get(l.id) || []);
    if (isFloorKind(l.kind)) for (const m of R.monByFloor.get(floorKey(l.floor)) || []) s.add(m);
    return Array.from(s);
  });

  /** Merge a people list ({who, ch, note} or plain ids/names) with back-references,
   *  de-duplicated by resolved character, sorted by chapter. */
  function mergeWho(list, extra) {
    const out = [], seen = new Map();
    const addOne = (x) => {
      if (x == null || x === '') return;
      const o = typeof x === 'object' ? x : { who: x };
      if (o.who == null || String(o.who).trim() === '') return;
      const r = resolve(o.who, ['characters']);
      const key = r ? 'c:' + r.e.id : 't:' + norm(o.who);
      const prev = seen.get(key);
      if (prev) {
        if (prev.ch == null && o.ch != null) prev.ch = o.ch;
        if (!hasText(prev.note) && hasText(o.note)) prev.note = o.note;
        return;
      }
      const rec = { who: o.who, ch: o.ch, note: o.note };
      seen.set(key, rec);
      out.push(rec);
    };
    arr(list).forEach(addOne);
    arr(extra).forEach(addOne);
    const chOf = (x) => { const n = toInt(x.ch); return n == null ? 1e9 : n; };
    return out.sort((a, b) => chOf(a) - chOf(b));
  }
  const essenceUsers = memo((es) => mergeWho(es.users, R.essHolders.get(es.id) || []));
  const skillUsers = memo((s) => mergeWho(s.users, (R.skillUsers.get(s.id) || []).map((c) => c.id)));
  const itemOwners = memo((i) => mergeWho(i.owners, (R.itemOwners.get(i.id) || []).map((c) => c.id)));
  const factionMembers = memo((f) => mergeWho(f.members, (R.charsByFaction.get(f.id) || []).map((c) => c.id)));

  /* ---------- chapters & arcs ---------- */
  function arcOfChapter(n) {
    const c = CH_BY_N.get(n);
    if (c && c.arc != null && ARC_BY_ID.has(String(c.arc))) return ARC_BY_ID.get(String(c.arc));
    return D.arcs.find((a) => a.range && n >= a.range[0] && n <= a.range[1]) || null;
  }
  const subarcOf = (a, n) => (a ? a.subarcs.find((s) => s.range && n >= s.range[0] && n <= s.range[1]) || null : null);
  function chaptersOfArc(a) {
    return D.chapters.filter((c) => (c.arc != null && String(c.arc) === a.id)
      || ((c.arc == null || !ARC_BY_ID.has(String(c.arc))) && a.range && c.n >= a.range[0] && c.n <= a.range[1]));
  }
  /** Previous / next chapter number that exists in DB.chapters. */
  function neighbor(n, dir) {
    if (dir < 0) { let best = null; for (const x of CH_NUMS) { if (x < n) best = x; else break; } return best; }
    for (const x of CH_NUMS) if (x > n) return x;
    return null;
  }
  /** Chapter -> {cat: [entities]} built on first use from every entity's refs. */
  let CH_INDEX = null;
  function chapterIndex() {
    if (CH_INDEX) return CH_INDEX;
    CH_INDEX = new Map();
    for (const cat of CATS) for (const e of D[cat]) for (const n of e.refs) {
      let m = CH_INDEX.get(n);
      if (!m) { m = {}; CH_INDEX.set(n, m); }
      (m[cat] || (m[cat] = [])).push(e);
    }
    return CH_INDEX;
  }

  /* ---------- story files (lazy <script> injection; works on file://) ---------- */
  const storyLoads = new Map();
  function loadStory(arcId) {
    const id = String(arcId == null ? '' : arcId);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return Promise.reject(new Error('bad arc id'));
    window.STORY = window.STORY || {};
    if (window.STORY[id]) return Promise.resolve(window.STORY[id]);
    if (storyLoads.has(id)) return storyLoads.get(id);
    const p = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'data/story/' + id + '.js';
      s.async = true;
      s.onload = () => (window.STORY && window.STORY[id] ? res(window.STORY[id]) : rej(new Error('empty story file')));
      s.onerror = () => { storyLoads.delete(id); s.remove(); rej(new Error('missing story file')); };
      document.head.appendChild(s);
    });
    storyLoads.set(id, p);
    return p;
  }

  /* =================================================================
   * 4. Text helpers — bilingual fields, names, links, badges, swatches
   * ================================================================= */

  /** Bilingual field -> text in the current language. Falls back to English,
   *  then to any language present. Plain strings/numbers pass through. */
  function t(x) {
    if (x == null) return '';
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (typeof x === 'object' && !Array.isArray(x)) {
      const v = x[lang];
      if (v != null && String(v).trim() !== '') return String(v);
      if (x.en != null && String(x.en).trim() !== '') return String(x.en);
      for (const k in x) if (typeof x[k] === 'string' && x[k].trim()) return x[k];
    }
    return '';
  }
  /** True when Thai is wanted but the field only has English (show an "EN" tag). */
  const isFallback = (x) => lang !== 'en' && !!x && typeof x === 'object' && !Array.isArray(x)
    && !(x[lang] && String(x[lang]).trim()) && !!(x.en && String(x.en).trim());
  const hasText = (x) => t(x).trim() !== '';
  const enTag = () => html`<span class="en-tag" title="${T('tag.en')}">EN</span>`;
  /** Short bilingual text, inline (**bold** and 「」 supported). noTag hides the EN tag (dense tables). */
  function tx(x, noTag) {
    const s = t(x);
    if (!s.trim()) return '';
    return html`${raw(inline(s))}${isFallback(x) && !noTag ? enTag() : ''}`;
  }
  /** Long bilingual text as a block, rendered with the markdown subset. */
  function block(x, cls) {
    const s = t(x);
    if (!s.trim()) return '';
    const fb = isFallback(x);
    const lg = fb ? 'en' : (x && typeof x === 'object' ? lang : document.documentElement.lang || 'en');
    return html`<div class="md${fb ? ' is-fallback' : ''}${cls ? ' ' + cls : ''}" lang="${lg}"${fb ? raw(' title="' + esc(T('tag.en')) + '"') : ''}>${raw(md(s))}</div>`;
  }

  /** Entity name in the current language: {main, alt}. In TH mode main = Thai name and
   *  alt = English (shown small beside it); in EN mode only the English name. */
  function nameParts(e) {
    const en = e.name || e.title || prettyId(e.id || '');
    const th = e.name_th || e.title_th || '';
    return lang === 'th' && th ? { main: th, alt: en } : { main: en, alt: '' };
  }
  /** Header variant: always shows both names (current language first). */
  function headNames(e) {
    const en = e.name || e.title || prettyId(e.id || '');
    const th = e.name_th || e.title_th || '';
    return lang === 'th' && th ? { main: th, alt: en } : { main: en, alt: th };
  }
  const plainName = (e) => nameParts(e).main;
  function nameHtml(e, noAlt) {
    const p = nameParts(e);
    return html`${p.main}${p.alt && !noAlt ? html`<small class="alt" lang="en">${p.alt}</small>` : ''}`;
  }
  const href = (cat, id) => '#/' + SINGULAR[cat] + '/' + encodeURIComponent(id);
  const entLink = (cat, e, noAlt) => html`<a href="${href(cat, e.id)}">${nameHtml(e, noAlt)}</a>`;

  /** Link for a reference (id, name, or {id,name}); unresolved values are plain text. */
  function refHtml(v, cats, noAlt) {
    if (v == null || v === '') return '';
    const r = resolve(v, cats);
    if (r) return entLink(r.cat, r.e, noAlt);
    const label = typeof v === 'object' ? (v.name || prettyId(v.id || '')) : prettyId(v);
    if (!String(label).trim()) return '';
    return html`<span class="unres" title="${T('ref.missing')}">${label}</span>`;
  }
  const refList = (vals, cats, noAlt) => joinHtml(arr(vals).map((v) => refHtml(v, cats, noAlt)));
  /** Like refList but shows at most `max` items plus "+N". */
  function refListShort(vals, cats, max) {
    const list = arr(vals);
    const shown = joinHtml(list.slice(0, max).map((v) => refHtml(v, cats, true)));
    return list.length > max ? html`${shown} <span class="muted">+${list.length - max}</span>` : shown;
  }

  function gradeBadge(g, long) {
    if (g == null || String(g).trim() === '') return '';
    const n = toInt(g);
    if (n == null || n < 1 || n > 9 || !/^\s*\d+\s*$/.test(String(g))) return html`<span class="badge">${g}</span>`;
    return html`<span class="grade g${n}" title="${T('grade.n', { n })}">${long ? T('grade.n', { n }) : n}</span>`;
  }
  const dash = () => html`<span class="muted">—</span>`;
  /** Grade badge, or the mixed grade of a synthetic (custom-made) essence such as "3+4+5" when it has no single grade. */
  function gradeOrMix(e, long) {
    if (!e) return '';
    const g = gradeBadge(e.grade, long);
    if (!blank(g)) return g;
    return e.grade_mix ? html`<span class="badge dim" title="${t(e.grade_note)}">${e.grade_mix}</span>` : '';
  }
  /** Synthetic essence parts: "Stats: Arbet (3)" / "Passive: Uumdal (4)" / "Active: Orc Hero (5)". */
  function madeFromHtml(e) {
    return joinHtml(arr(e && e.made_from).filter((m) => m && (m.essence || m.label))
      .map((m) => html`<span>${tx(m.part, true)}: ${m.essence ? refHtml(m.essence, ['essences', 'monsters']) : tx(m.label, true)} ${gradeBadge(m.grade)}</span>`), raw('<br>'));
  }
  function statusBadge(s) {
    if (!s) return '';
    const k = String(s).toLowerCase();
    const cls = k === 'alive' ? 'pos' : (k === 'dead' || k === 'deceased') ? 'crimson' : k === 'missing' ? 'amber' : 'dim';
    return html`<span class="badge ${cls}">${enumLabel(s)}</span>`;
  }
  const isEvil = (c) => c.evil_spirit === true || c.evil_spirit === 'true' || c.evil_spirit === 1;
  const impLabel = (n) => { const i = toInt(n); return i >= 1 && i <= 3 ? T('imp.' + i) : (n == null ? '' : String(n)); };

  const COLOR_ALIAS = { violet: 'purple', scarlet: 'red', crimson: 'red', golden: 'gold', navy: 'indigo', gray: 'grey',
    prismatic: 'rainbow', 'seven-colored': 'rainbow', 'seven-coloured': 'rainbow', multicolored: 'rainbow',
    multicoloured: 'rainbow', dark: 'black', azure: 'blue', teal: 'green' };
  const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'black', 'white', 'gold', 'silver', 'rainbow', 'pink', 'brown', 'grey'];
  /** Essence colour -> one of COLORS, "other" (unknown word) or "unknown" (empty). */
  function colorKey(c) {
    const k = slug(c);
    if (!k) return 'unknown';
    const a = COLOR_ALIAS[k] || k;
    return COLORS.indexOf(a) >= 0 ? a : 'other';
  }
  const colorVal = (c) => { const k = colorKey(c); return k === 'other' ? norm(c) : k; };
  function colorName(c) {
    const k = colorKey(c);
    if (k === 'other') return cap(c);
    return T('color.' + k);
  }
  function swatch(c, withLabel) {
    const k = colorKey(c), nm = colorName(c);
    return withLabel
      ? html`<span class="swc"><span class="sw sw-${k}" aria-hidden="true"></span>${nm}</span>`
      : html`<span class="sw sw-${k}" role="img" aria-label="${nm}" title="${nm}"></span>`;
  }
  /** "+140" green, "-20" red (shown with a real minus sign). */
  function statVal(v) {
    const s = String(v == null ? '' : v).trim();
    const num = typeof v === 'number' ? v : null;
    const neg = /^[-−–]/.test(s) || (num != null && num < 0);
    const pos = /^\+/.test(s) || (num != null && num > 0);
    const shown = num != null && num > 0 ? '+' + num : s.replace(/^[-–]/, '−');
    return html`<span class="${neg ? 'val-neg' : pos ? 'val-pos' : ''}">${shown}</span>`;
  }
  function statsInline(stats, max) {
    const list = arr(stats).filter((s) => s && (s.stat || s.value != null));
    const lim = max ? list.slice(0, max) : list;
    const parts = lim.map((s) => html`<span>${tx(s.stat, true)} ${statVal(s.value)}</span>`);
    return html`<span class="statline">${parts}${max && list.length > max ? html`<span class="muted">+${list.length - max}</span>` : ''}</span>`;
  }

  function chTitle(c) { return c ? (lang === 'th' && c.title_th ? c.title_th : (c.title || '')) : ''; }
  function chChip(n) {
    const c = CH_BY_N.get(n);
    return html`<a class="chip" href="#/chapter/${n}"${c ? raw(' title="' + esc(chTitle(c)) + '"') : ''}>${T('ch.short', { n })}</a>`;
  }
  function arcLabel(a) { return T('arc.n', { n: a.n == null ? '?' : a.n }) + ': ' + plainName(a); }
  const rangeText = (r) => (r ? T('arc.range', { a: r[0], b: r[1] }) : '');

  /** Skill entity for a skill name shown on an essence page (same source first). */
  function findSkill(name, sourceId) {
    if (!name) return null;
    return R.skillBySrc.get(String(sourceId || '') + '|' + norm(name)) || resolveE(name, 'skills');
  }
  function skillName(name, sourceId) {
    const s = findSkill(name, sourceId);
    return s ? entLink('skills', s) : (name ? html`<span>${name}</span>` : '');
  }
  function sourceCats(type) {
    const k = norm(type);
    if (k === 'essence') return ['essences'];
    if (k === 'item' || k === 'item skill') return ['items'];
    if (k === 'race' || k === 'racial') return ['races'];
    if (k === 'monster') return ['monsters'];
    if (k === 'character' || k === 'class') return ['characters'];
    if (k === 'faction') return ['factions'];
    return null;
  }
  function sourceHtml(src, withType) {
    if (!src) return '';
    if (typeof src !== 'object') return refHtml(src, null, true);
    const link = refHtml({ id: src.id, name: src.name }, sourceCats(src.type), true);
    if (!withType || !src.type) return link;
    return html`<span class="muted">${enumLabel(src.type)}:</span> ${link}`;
  }
  const sourceName = (src) => {
    if (!src) return '';
    if (typeof src !== 'object') return String(src);
    const r = resolve({ id: src.id, name: src.name }, sourceCats(src.type));
    return r ? plainName(r.e) : (src.name || prettyId(src.id || ''));
  };

  /* =================================================================
   * 5. Markdown — the subset used by scene summaries and lore bodies:
   *    #/##/### headings, * - + bullets (nested by indent), 1. lists,
   *    **bold**, *italic*, `code`, > blockquotes (system messages), 「 」 text,
   *    ---, GFM pipe tables, [[Name]] / [[Name|label]] / [[race:Name]] entity
   *    links, auto-linked chapter refs ("Ch. 12, 15"), and paragraphs.
   *    HTML in the source is always escaped first (only a literal <br> survives).
   *    ```jsonl fences (the agents' observation blocks) are dropped.
   * ================================================================= */
  const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  const unesc = (x) => String(x).replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);
  /** [[Name]], [[Name|label]], [[race:Name]] -> link to the entity (any category); plain text when unresolved.
   *  Works on already-escaped text, so the label is safe to insert as is. */
  function wikiLink(target, label) {
    let tg = unesc(target).trim(), cats = null;
    const pm = tg.match(/^([a-z]+)\s*:\s*(.+)$/i);
    if (pm) {
      const k = pm[1].toLowerCase();
      const c = CATS.indexOf(k) >= 0 ? k : CATS.find((x) => SINGULAR[x] === k);
      if (c) { cats = [c]; tg = pm[2].trim(); }
    }
    const r = tg ? resolve(tg, cats) : null;
    const shown = label != null && label.trim() ? label.trim() : esc(r && r.e.id === tg ? plainName(r.e) : tg);
    return r ? '<a href="' + esc(href(r.cat, r.e.id)) + '">' + shown + '</a>' : shown;
  }
  /** "Ch. 12", "ch.12", "Chapter 12", "Chs. 12, 15 & 20", "Ch. 12–15", "ตอนที่ 12" -> each number links to the chapter. */
  const CHREF_RE = /(\b(?:chapters?|chs?)\b\.?|ตอนที่|บทที่|บท(?=\s*\d))(\s*)(\d{1,4}(?!\d)(?:\s*(?:,|&amp;|and|[–—~-])\s*\d{1,4}(?!\d))*)/gi;
  function linkChapters(text) {
    const total = (D.meta && D.meta.chapters_total) || 9999;
    return text.replace(CHREF_RE, (m0, word, sp, nums) => {
      let lead = word + sp;
      return nums.replace(/\d{1,4}/g, (d) => {
        const n = +d, pre = lead;
        lead = '';
        return n >= 1 && n <= total ? '<a class="chref" href="#/chapter/' + n + '">' + pre + d + '</a>' : pre + d;
      });
    });
  }
  /** Chapter links only in text outside tags and outside existing links. */
  function linkChaptersHtml(h) {
    if (!/\d/.test(h)) return h;
    return h.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/).map((seg, i) => (i % 2 ? seg : linkChapters(seg))).join('');
  }
  function inline(s) {
    const codes = [];
    let h = esc(s).replace(/`([^`]+)`/g, (m0, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    h = h.replace(/\[\[([^\]|]+?)(?:\|([^\]]*?))?\]\]/g, (m0, tg, lb) => wikiLink(tg, lb))
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/~~(.+?)~~/g, '<del class="rm">$1</del>')
      .replace(/(^|[\s(\[])\*(?=[^\s*])([^*]+?)\*(?=$|[\s).,;:!?\]])/g, '$1<em>$2</em>')
      .replace(/「([^」]*)」/g, '<span class="sys">「$1」</span>');
    h = linkChaptersHtml(h);
    return codes.length ? h.replace(/\u0000(\d+)\u0000/g, (m0, i) => '<code>' + codes[+i] + '</code>') : h;
  }
  function renderList(items) {
    let out = '';
    const stack = [];
    for (const it of items) {
      const tag = it.ordered ? 'ol' : 'ul';
      while (stack.length && stack[stack.length - 1].depth > it.depth) out += '</li></' + stack.pop().tag + '>';
      const top = stack[stack.length - 1];
      if (top && top.depth === it.depth && top.tag !== tag) out += '</li></' + stack.pop().tag + '>';
      const cur = stack[stack.length - 1];
      if (!cur || cur.depth < it.depth) {
        out += '<' + tag + (it.ordered && it.start > 1 ? ' start="' + it.start + '"' : '') + '>';
        stack.push({ tag, depth: it.depth });
      } else out += '</li>';
      out += '<li>' + inline(it.text);
    }
    while (stack.length) out += '</li></' + stack.pop().tag + '>';
    return out;
  }
  /** GFM table row -> cells. Pipes inside [[a|b]] links and `code` do not split; \| is a literal pipe. */
  function splitRow(line) {
    let x = line.trim();
    if (x.charAt(0) === '|') x = x.slice(1);
    if (x.slice(-1) === '|' && x.slice(-2) !== '\\|') x = x.slice(0, -1);
    const cells = [];
    let cur = '', depth = 0, code = false;
    for (let i = 0; i < x.length; i++) {
      const c = x.charAt(i), nx = x.charAt(i + 1);
      if (c === '\\' && nx === '|') { cur += '|'; i++; continue; }
      if (c === '`') code = !code;
      else if (!code && c === '[' && nx === '[') { depth++; cur += '[['; i++; continue; }
      else if (!code && c === ']' && nx === ']' && depth) { depth--; cur += ']]'; i++; continue; }
      else if (c === '|' && !depth && !code) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }
  const TBL_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  function renderTable(head, sep, rows) {
    const al = sep.map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'num' : ''));
    const cell = (tag, c, j) => '<' + tag + (al[j] ? ' class="' + al[j] + '"' : '') + '>'
      + (tag === 'th' ? '<span class="th-static">' + inline(c) + '</span>' : inline(c)) + '</' + tag + '>';
    // a minimum width per column keeps wide tables readable on phones (the wrapper scrolls sideways)
    return '<div class="table-wrap md-table"><table class="db compact" style="min-width:' + Math.min(head.length * 7, 56) + 'em"><thead><tr>' + head.map((c, j) => cell('th', c, j)).join('')
      + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + head.map((x, j) => cell('td', r[j] == null ? '' : r[j], j)).join('') + '</tr>').join('')
      + '</tbody></table></div>';
  }
  function md(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [], quote = [], list = null, fence = null;
    const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushQuote = () => { if (quote.length) { out.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>'); quote = []; } };
    const flushList = () => { if (list) { out.push(renderList(list)); list = null; } };
    const flushAll = () => { flushPara(); flushQuote(); flushList(); };
    const closeFence = () => { if (fence && !/^jsonl?$/.test(fence.lang)) out.push('<pre>' + esc(fence.body.join('\n')) + '</pre>'); fence = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence) { if (/^\s*```/.test(line)) closeFence(); else fence.body.push(line); continue; }
      let m = line.match(/^\s*```\s*([\w-]*)/);
      if (m) { flushAll(); fence = { lang: m[1].toLowerCase(), body: [] }; continue; }
      if (!line.trim()) { flushAll(); continue; }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && TBL_SEP.test(lines[i + 1])) {
        const head = splitRow(line), sep = splitRow(lines[i + 1]);
        if (sep.length === head.length && (head.length > 1 || lines[i + 1].indexOf('|') >= 0) && sep.every((c) => /^:?-+:?$/.test(c))) {
          flushAll();
          const rows = [];
          for (i += 2; i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0; i++) rows.push(splitRow(lines[i]));
          i--;
          out.push(renderTable(head, sep, rows));
          continue;
        }
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flushAll();
        const lv = m[1].length, tag = lv <= 3 ? 'h3' : lv === 4 ? 'h4' : 'h5';
        out.push('<' + tag + '>' + inline(m[2]) + '</' + tag + '>');
        continue;
      }
      if (/^\s{0,3}([*\-_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
      if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = line.match(/^(\s*)([*+-]|\d{1,3}[.)])\s+(.*)$/))) {
        flushPara(); flushQuote();
        const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
        const ordered = /\d/.test(m[2]);
        (list || (list = [])).push({ depth, ordered, start: ordered ? parseInt(m[2], 10) : 1, text: m[3] });
        continue;
      }
      if (list && /^\s+\S/.test(line)) { list[list.length - 1].text += ' ' + line.trim(); continue; }
      flushQuote(); flushList();
      para.push(line.trim());
    }
    closeFence();
    flushAll();
    return out.join('\n');
  }

  /* =================================================================
   * 6. Components
   * ================================================================= */
  const ICON = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>', chevU: '<path d="m6 15 6-6 6 6"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>', chevL: '<path d="m15 6-6 6 6 6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    story: '<path d="M3 5.5c3-1.3 6-1.3 9 .8 3-2.1 6-2.1 9-.8v13c-3-1.3-6-1.3-9 .8-3-2.1-6-2.1-9-.8z"/><path d="M12 6.3v13"/>',
    races: '<circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M3 19.5c.6-3.6 2.9-5.6 5.5-5.6s4.9 2 5.5 5.6"/><path d="M15 14.4c.5-.2 1-.3 1.5-.3 2.2 0 4 1.6 4.5 4.4"/>',
    characters: '<path d="M6.5 13.5a5.5 5.5 0 0 1 11 0V18h-11z"/><path d="M6.6 11.5 3.5 6.5l.6 6M17.4 11.5l3.1-5-.6 6"/><path d="M10 18v-3.2h4V18"/>',
    monsters: '<path d="M6 3.5c1.6 5.5 1.4 11-1 17M12 3c1.6 6 1.6 12 0 18M18 3.5c-1.6 5.5-1.4 11 1 17"/>',
    essences: '<path d="M9.5 3h5M10.5 3v6.2L6 17.5A2.6 2.6 0 0 0 8.3 21h7.4a2.6 2.6 0 0 0 2.3-3.5L13.5 9.2V3"/><path d="M7.7 14.5h8.6"/>',
    skills: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
    items: '<path d="m10.5 7.5 4-4 6 6-4 4z"/><path d="M13.5 10.5 3.5 20.5"/>',
    locations: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>',
    factions: '<path d="M5 21V3.5"/><path d="M5 4h13l-3 4.2 3 4.3H5"/>',
    lore: '<path d="M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z"/><path d="M6 18a2 2 0 0 1 2-2h11"/><path d="M10 8h5M10 11h3"/>',
  };
  const icon = (name, cls) => raw('<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[name] || '') + '</svg>');

  /** Round barbarian shield: the brand mark (styled with theme variables). */
  const SIGIL = raw('<svg class="sigil" viewBox="0 0 32 32" aria-hidden="true" focusable="false">'
    + '<circle cx="16" cy="16" r="14.4" style="fill:var(--panel-2);stroke:var(--amber)" stroke-width="2.2"/>'
    + '<path d="M11 5.6v20.8M21 5.6v20.8" style="stroke:var(--amber)" stroke-width="1.3" opacity=".5"/>'
    + '<circle cx="16" cy="16" r="10.2" style="fill:none;stroke:var(--amber)" stroke-width=".9" opacity=".35"/>'
    + '<circle cx="16" cy="16" r="4.4" style="fill:var(--amber)"/><circle cx="16" cy="16" r="1.5" style="fill:var(--panel-2)"/></svg>');

  /** Circular flags as inline SVG (emoji flags do not render on Windows). The .flag span clips to a circle. */
  const FLAGS = (function () {
    const th = '<svg viewBox="0 0 30 30" aria-hidden="true" focusable="false"><rect width="30" height="30" fill="#f4f5f8"/>'
      + '<rect width="30" height="5" fill="#a51931"/><rect y="10" width="30" height="10" fill="#2d2a4a"/>'
      + '<rect y="25" width="30" height="5" fill="#a51931"/></svg>';
    let us = '<svg viewBox="0 0 26 26" aria-hidden="true" focusable="false"><rect width="26" height="26" fill="#ffffff"/>';
    for (let y = 0; y < 26; y += 4) us += '<rect y="' + y + '" width="26" height="2" fill="#b22234"/>';
    us += '<rect width="13" height="14" fill="#3c3b6e"/>';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      us += '<circle cx="' + (2.2 + c * 3 + (r % 2) * 1.2).toFixed(1) + '" cy="' + (2.4 + r * 3).toFixed(1) + '" r=".75" fill="#ffffff"/>';
    }
    us += '</svg>';
    return { th, en: us };
  })();
  const flag = (code) => raw('<span class="flag">' + (FLAGS[code] || '') + '</span>');

  function crumbs(items) {
    return html`<nav class="crumbs" aria-label="Breadcrumb">${items.map((it, i) => html`${i ? html`<span class="sep" aria-hidden="true">›</span>` : ''}${it[1] ? html`<a href="${it[1]}">${it[0]}</a>` : html`<span aria-current="page">${it[0]}</span>`}`)}</nav>`;
  }
  /** RMS-style info box: [[label, valueHtml], …]; rows with empty values are skipped. */
  function infobox(rows) {
    const body = rows.filter((r) => r && !blank(r[1])).map((r) => html`<tr><th scope="row">${r[0]}</th><td>${r[1]}</td></tr>`);
    return body.length ? html`<table class="infobox"><tbody>${body}</tbody></table>` : '';
  }
  /** A titled section; empty bodies produce nothing (sections hide when data is missing). */
  let TOC = null;   // [[id, labelHtml]] collected while a detail page renders (see viewDetail / detailShell)
  function tocAdd(key, title) {
    if (!TOC) return;
    const lbl = typeof title === 'string' ? esc(title)
      : toHtml(title).replace(/<span class="(?:en-tag|count)"[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
    if (lbl) TOC.push([key, lbl]);
  }
  function section(key, title, body) {
    if (blank(body)) return '';
    tocAdd(key, title);
    return html`<section class="sec" id="s-${key}"><h2>${title}</h2>${body}</section>`;
  }
  /** Section folded away in a closed <details>; the heading is the toggle. */
  function foldSection(key, title, body, count) {
    if (blank(body)) return '';
    tocAdd(key, title);
    return html`<section class="sec fold" id="s-${key}"><details class="sec-fold"><summary><h2>${title}${count ? html` <span class="count">${count}</span>` : ''}</h2></summary>${body}</details></section>`;
  }
  /** Curated `sections: [{title: L, body: L(markdown)}]` of any entity, in the given order. */
  function customSections(e) {
    const used = new Set();
    return arr(e.sections).filter((x) => x && typeof x === 'object' && (hasText(x.title) || hasText(x.body))).map((x, i) => {
      const en = x.title && typeof x.title === 'object' && x.title.en ? x.title.en : t(x.title);
      let key = 'x-' + (slug(en).slice(0, 48) || String(i + 1));
      while (used.has(key)) key += '-' + (i + 1);
      used.add(key);
      return section(key, hasText(x.title) ? tx(x.title) : T('sec.body'), block(x.body, 'long'));
    });
  }
  function tocNav(toc) {
    if (toc.length < 5) return '';
    const here = location.hash || '#/';
    return html`<nav class="toc" aria-label="${T('toc.title')}"><h2>${T('toc.title')}</h2><ol>${toc.map((x) => html`<li><a href="${here}" data-scroll="s-${x[0]}">${raw(x[1])}</a></li>`)}</ol></nav>`;
  }
  /** First `max` fragments; the rest sit behind a "+N more" toggle. sep '' suits flex link lists. */
  function capList(parts, max, sep) {
    const list = parts.map(toHtml).filter((x) => x.trim() !== '');
    const sp = sep == null ? ', ' : sep;
    if (list.length <= max + 1) return raw(list.join(sp));
    const more = T('more.n', { n: fmtNum(list.length - max) });
    return raw(list.slice(0, max).join(sp) + '<span class="cap-rest" hidden>' + sp + list.slice(max).join(sp) + '</span>'
      + ' <button type="button" class="more-btn" data-act="cap-more" aria-expanded="false" data-more="' + esc(more) + '" data-less="' + esc(T('more.less')) + '">' + esc(more) + '</button>');
  }
  /** Small static table. cols: [{label, cls}], rows: arrays of cell HTML. */
  function miniTable(cols, rows) {
    if (!rows.length) return '';
    return html`<div class="table-wrap"><table class="db compact"><thead><tr>${cols.map((c) => html`<th class="${c.cls || ''}"><span class="th-static">${c.label}</span></th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((cell, i) => html`<td class="${cols[i] && cols[i].cls ? cols[i].cls : ''}">${cell}</td>`)}</tr>`)}</tbody></table></div>`;
  }
  const chCell = (ch) => { const n = toInt(ch); return n != null ? chChip(n) : ''; };
  const TL_GROUP_MIN = 10;
  /** Chapter-ordered list of {ch, text}. Long lists are grouped by story arc (DB.chapters[].arc) in
   *  <details> blocks with a count; the first two arcs start open. */
  function timeline(items) {
    const chOf = (x) => { const n = toInt(x.ch); return n == null ? 1e9 : n; };
    const list = arr(items).filter((x) => x && (toInt(x.ch) != null || hasText(x.text))).slice().sort((a, b) => chOf(a) - chOf(b));
    if (!list.length) return '';
    const ol = (xs) => html`<ol class="timeline">${xs.map((x) => html`<li><div class="tl-ch">${chCell(x.ch)}</div><div class="tl-text">${tx(x.text)}</div></li>`)}</ol>`;
    if (list.length < TL_GROUP_MIN) return ol(list);
    const groups = new Map();
    for (const x of list) {
      const n = toInt(x.ch), a = n != null ? arcOfChapter(n) : null;
      const k = a ? a.id : n == null ? '~undated' : '~other';
      if (!groups.has(k)) groups.set(k, { a, k, xs: [] });
      groups.get(k).xs.push(x);
    }
    if (groups.size < 2) return ol(list);
    return html`<div class="tl-groups">
      <div class="tl-tools"><span class="muted small">${T('tl.count', { n: fmtNum(list.length) })}</span><span class="spacer"></span><button type="button" class="btn" data-act="tl-open">${T('maps.expand')}</button><button type="button" class="btn" data-act="tl-close">${T('maps.collapse')}</button></div>
      ${Array.from(groups.values()).map((g, i) => html`<details class="tl-arc"${i < 2 ? raw(' open') : ''}><summary><span class="tl-arc-name">${g.a ? arcLabel(g.a) : T(g.k === '~undated' ? 'tl.undated' : 'tl.noArc')}</span>${g.a && g.a.range ? html`<span class="tl-arc-range">${rangeText(g.a.range)}</span>` : ''}<span class="count">${fmtNum(g.xs.length)}</span></summary>${ol(g.xs)}</details>`)}
    </div>`;
  }
  /** level_history [{ch, level}] -> "Lv 1 · Ch. 1 → Lv 2 · Ch. 21 …" (first chapter of each new level). */
  function levelStrip(hist) {
    const pts = arr(hist).filter((h) => h && h.level != null && String(h.level).trim() !== '')
      .map((h) => ({ ch: toInt(h.ch), lv: String(h.level).trim() }))
      .sort((a, b) => (a.ch == null ? 1e9 : a.ch) - (b.ch == null ? 1e9 : b.ch));
    const steps = [];
    for (const p of pts) if (!steps.length || steps[steps.length - 1].lv !== p.lv) steps.push(p);
    if (!steps.length) return '';
    // plain numbers read "Lv 8"; any other wording (e.g. "level up (to 8)") is shown as written, muted
    return html`<ol class="lvl-strip">${steps.map((p) => html`<li>${/^\d+(\.\d+)?\+?$/.test(p.lv) ? html`<span class="lv">${T('lvl.n', { n: p.lv })}</span>` : html`<span class="lv-text">${p.lv}</span>`}${p.ch != null ? chChip(p.ch) : ''}</li>`)}</ol>`;
  }
  /** Skill stages [{stage, name, effect, ch, cost, note}] sorted by stage; empty columns are dropped. */
  const stageNum = (x) => { const m = String(x.stage == null ? '' : x.stage).match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 1e9; };
  const stagesOf = (e) => arr(e.stages).filter((x) => x && typeof x === 'object' && (x.stage != null || hasText(x.name) || hasText(x.effect)));
  function stagesTable(e) {
    const st = stagesOf(e).slice().sort((a, b) => stageNum(a) - stageNum(b) || (toInt(a.ch) || 1e9) - (toInt(b.ch) || 1e9));
    if (!st.length) return '';
    const cols = [{ label: T('th.stage'), cls: 'center nowrap' }, { label: T('th.name') }, { label: T('th.effect'), cls: 'wide' },
      { label: T('th.revealed'), cls: 'nowrap' }, { label: T('th.costCond') }, { label: T('th.note') }];
    const rows = st.map((x) => [x.stage == null || String(x.stage).trim() === '' ? '' : html`<span class="badge amber">${t(x.stage)}</span>`,
      html`<strong>${tx(x.name, true)}</strong>`, tx(x.effect), chCell(x.ch), tx(x.cost), tx(x.note)]);
    const keep = cols.map((c, j) => j < 3 || rows.some((r) => !blank(r[j])));
    return miniTable(cols.filter((c, j) => keep[j]), rows.map((r) => r.filter((c, j) => keep[j])));
  }
  /** Monster EXP [{value, ch, note}] and drops_list [{item, ch, note}]. */
  const expList = (e) => arr(e.exp).filter((x) => x && typeof x === 'object' && x.value != null && String(t(x.value)).trim() !== '');
  const expNum = (v) => { if (typeof v === 'number') return v; const m = t(v).match(/\d[\d,]*(\.\d+)?/); return m ? parseFloat(m[0].replace(/,/g, '')) : null; };
  const expText = (v) => (typeof v === 'number' ? fmtNum(v) : t(v));
  function maxExp(e) { let best = null; for (const x of expList(e)) { const n = expNum(x.value); if (n != null && (best == null || n > best)) best = n; } return best; }
  function expHtml(e) {
    const xs = expList(e);
    return xs.length ? html`<ul class="exp-list">${xs.map((x) => html`<li><strong>${expText(x.value)}</strong>${toInt(x.ch) != null ? html` ${chChip(toInt(x.ch))}` : ''}${hasText(x.note) ? html` <span class="muted small">${tx(x.note)}</span>` : ''}</li>`)}</ul>` : '';
  }
  const dropItem = (v) => (v && typeof v === 'object' && v.id == null && v.name == null ? tx(v) : refHtml(v, ['items', 'essences']));
  const hasDrops = (e) => arr(e.drops_list).some((d) => d && (d.item || hasText(d.note))) || hasText(e.drops);
  function dropsTable(e) {
    const xs = arr(e.drops_list).filter((d) => d && (d.item || hasText(d.note)));
    return miniTable([{ label: T('th.drop') }, { label: T('th.chapter'), cls: 'nowrap' }, { label: T('th.note') }],
      xs.map((d) => [dropItem(d.item), chCell(d.ch), tx(d.note)]));
  }
  /** Bulleted list of bilingual strings. */
  function bullets(list) {
    const items = arr(list).filter(hasText);
    return items.length ? html`<ul class="plain">${items.map((x) => html`<li>${tx(x)}</li>`)}</ul>` : '';
  }
  const APPEARS_FIRST = 60;
  /** "Appears in chapters": chip per chapter; long lists collapse after 60. Every detail page ends with it. */
  function appearsIn(refs) {
    const n = refs.length;
    let body;
    if (!n) body = html`<p class="muted">${T('appears.none')}</p>`;
    else {
      const more = n > APPEARS_FIRST;
      body = html`<p class="muted small">${n === 1 ? T('appears.one') : T('appears.summary', { n: fmtNum(n), a: refs[0], b: refs[n - 1] })}</p>
        <div class="chips"${more ? raw(' data-refs="' + refs.join(',') + '"') : ''}>${refs.slice(0, APPEARS_FIRST).map(chChip)}${more ? html`<button type="button" class="chip more" data-act="more-refs">${T('appears.more', { n: fmtNum(n - APPEARS_FIRST) })}</button>` : ''}</div>`;
    }
    return html`<section class="sec appears" id="s-appears"><h2>${T('sec.appears')}</h2>${body}</section>`;
  }

  /* =================================================================
   * 7. Categories — list columns and filters (detail pages below).
   *    Column: {key, label, cls, cell(e, cat) -> html, sort(e) -> value, dir}
   *    Filter: {key (URL param), label, options(list) -> [{value,label,count}], test(e, value)}
   * ================================================================= */
  const colName = (label) => ({ key: 'name', label: label || 'col.name', cls: 'name', cell: (e, cat) => entLink(cat, e), sort: (e) => plainName(e) });
  const colFirst = () => ({ key: 'first', label: 'col.first', cls: 'num nowrap', cell: (e) => (e.refs.length ? chChip(e.refs[0]) : ''), sort: (e) => (e.refs.length ? e.refs[0] : null) });
  const colChapters = () => ({ key: 'chapters', label: 'col.chapters', cls: 'num', dir: 'desc', cell: (e) => fmtNum(e.refs.length), sort: (e) => e.refs.length });
  const colGrade = () => ({ key: 'grade', label: 'col.grade', cls: 'center', cell: (e) => (blank(gradeOrMix(e)) ? dash() : gradeOrMix(e)), sort: (e) => toInt(e.grade) });
  const colEnum = (key, label, get) => ({ key, label, cell: (e) => enumLabel(get(e)), sort: (e) => (get(e) ? enumLabel(get(e)) : null) });

  /** Filter over a text field (scalar or array). Options + counts come from the data. */
  function enumFilter(key, label, get, show, order) {
    return {
      key, label,
      options(list) {
        const counts = new Map(), first = new Map();
        for (const e of list) for (const v of new Set(arr(get(e)).filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim()))) {
          const k = v.toLowerCase();
          counts.set(k, (counts.get(k) || 0) + 1);
          if (!first.has(k)) first.set(k, v);
        }
        const opts = Array.from(counts.keys()).map((k) => ({ value: k, label: show ? show(first.get(k)) : enumLabel(first.get(k)), count: counts.get(k) }));
        return opts.sort((a, b) => (order ? order(a.value) - order(b.value) : 0) || collator.compare(a.label, b.label));
      },
      test: (e, v) => arr(get(e)).some((x) => x != null && String(x).trim().toLowerCase() === v),
    };
  }
  function boolFilter(key, label, pred, yes, no) {
    return {
      key, label,
      options(list) { let y = 0; for (const e of list) if (pred(e)) y++; return [{ value: 'yes', label: T(yes || 'opt.yes'), count: y }, { value: 'no', label: T(no || 'opt.no'), count: list.length - y }]; },
      test: (e, v) => (v === 'yes' ? !!pred(e) : !pred(e)),
    };
  }
  function gradeFilter() {
    const key = (e) => { const n = toInt(e.grade); return n >= 1 && n <= 9 ? String(n) : 'none'; };
    return {
      key: 'grade', label: 'f.grade',
      options(list) {
        const c = new Map();
        for (const e of list) { const k = key(e); c.set(k, (c.get(k) || 0) + 1); }
        return Array.from(c.keys()).sort((a, b) => (a === 'none' ? 99 : +a) - (b === 'none' ? 99 : +b))
          .map((k) => ({ value: k, label: k === 'none' ? T('opt.unknown') : T('grade.n', { n: k }), count: c.get(k) }));
      },
      test: (e, v) => key(e) === v,
    };
  }
  function floorFilter(get) {
    return {
      key: 'floor', label: 'f.floor',
      options(list) {
        const c = new Map(), lbl = new Map();
        for (const e of list) for (const f of new Set(arr(get(e)).map(floorKey).filter(Boolean))) {
          c.set(f, (c.get(f) || 0) + 1);
          if (!lbl.has(f)) lbl.set(f, /^u?\d+$/.test(f) ? floorLabel(f) : cap(f));
        }
        return Array.from(c.keys()).sort((a, b) => floorOrder(a) - floorOrder(b) || a.localeCompare(b))
          .map((k) => ({ value: k, label: lbl.get(k), count: c.get(k) }));
      },
      test: (e, v) => arr(get(e)).some((f) => floorKey(f) === v),
    };
  }
  const raceOf = (c) => { const r = c.race ? resolveE(c.race, 'races') : null; return r ? r.id : c.race; };
  const numberSort = (s) => { if (!s) return null; const d = String(s).match(/\d+/); return d ? +d[0] : String(s); };

  const CATDEF = {
    races: {
      columns: [colName(),
        { key: 'abilities', label: 'col.abilities', cls: 'wide', cell: (e) => joinHtml(arr(e.abilities).map((a) => (a && a.name) || '')), sort: (e) => arr(e.abilities).map((a) => (a && a.name) || '').join(', ') || null },
        { key: 'people', label: 'col.people', cls: 'num', dir: 'desc', cell: (e) => fmtNum((R.charsByRace.get(e.id) || []).length), sort: (e) => (R.charsByRace.get(e.id) || []).length },
        colFirst(), colChapters()],
      filters: [],
    },
    characters: {
      defaultSort: 'importance',
      columns: [colName(),
        { key: 'race', label: 'col.race', cell: (e) => refHtml(e.race, ['races'], true), sort: (e) => { const r = resolveE(e.race, 'races'); return r ? plainName(r) : (e.race || null); } },
        { key: 'roles', label: 'col.roles', cls: 'wide', cell: (e) => joinHtml(arr(e.roles).map((r) => tx(r, true))), sort: (e) => arr(e.roles).map(t).join(', ') || null },
        { key: 'status', label: 'col.status', cell: (e) => statusBadge(e.status), sort: (e) => (e.status ? enumLabel(e.status) : null) },
        { key: 'importance', label: 'col.importance', cell: (e) => impLabel(e.importance), sort: (e) => toInt(e.importance) },
        { key: 'evil', label: 'col.evil', cls: 'center', cell: (e) => (isEvil(e) ? html`<span class="badge crimson">${T('yes')}</span>` : ''), sort: (e) => (isEvil(e) ? 0 : null) },
        colFirst(), colChapters()],
      filters: [
        enumFilter('race', 'f.race', raceOf, (v) => { const r = BY_ID.races.get(v); return r ? plainName(r) : enumLabel(v); }),
        enumFilter('imp', 'f.importance', (e) => (e.importance == null ? null : String(e.importance)), (v) => impLabel(v), (v) => +v || 99),
        enumFilter('status', 'f.status', (e) => e.status),
        boolFilter('evil', 'f.evil', isEvil),
      ],
      extra: (e) => [e.mask],
    },
    monsters: {
      columns: [colName(), colGrade(),
        { key: 'exp', label: 'col.exp', cls: 'num nowrap', dir: 'desc', cell: (e) => { const m = maxExp(e); return m != null ? fmtNum(m) : (expList(e).length ? expText(expList(e)[0].value) : ''); }, sort: (e) => maxExp(e) },
        colEnum('category', 'col.category', (e) => e.category),
        { key: 'floors', label: 'col.floors', cls: 'nowrap', cell: (e) => joinHtml(arr(e.floors).map(floorLabel)), sort: (e) => { const ks = arr(e.floors).map(floorKey).filter(Boolean); return ks.length ? Math.min.apply(null, ks.map(floorOrder)) : null; } },
        { key: 'zones', label: 'col.zones', cls: 'wide', cell: (e) => refListShort(e.zones, ['locations'], 3), sort: (e) => { const z = arr(e.zones)[0]; const l = z ? resolveE(z, 'locations') : null; return l ? plainName(l) : (z || null); } },
        { key: 'essence', label: 'col.essence', cell: (e) => { const es = R.essOfMon.get(e.id); return es ? entLink('essences', es, true) : ''; }, sort: (e) => (R.essOfMon.has(e.id) ? 0 : null) },
        colFirst(), colChapters()],
      filters: [gradeFilter(), floorFilter((e) => e.floors), enumFilter('category', 'f.category', (e) => e.category),
        boolFilter('drops', 'f.drops', hasDrops, 'opt.hasDrops', 'opt.noDrops')],
      extra: (e) => [e.category].concat(arr(e.floors)),
    },
    essences: {
      columns: [colName(), colGrade(),
        { key: 'colors', label: 'col.colors', cell: (e) => html`<span class="statline">${arr(e.colors).map((c) => swatch(c, true))}</span>`, sort: (e) => arr(e.colors).map(colorKey).join(',') || null },
        { key: 'monster', label: 'col.monster', cell: (e) => { const m = R.monOfEss.get(e.id); return m ? entLink('monsters', m, true) : refHtml(e.monster, ['monsters'], true); }, sort: (e) => { const m = R.monOfEss.get(e.id); return m ? plainName(m) : null; } },
        { key: 'stats', label: 'col.stats', cls: 'wide', cell: (e) => statsInline(e.stats, 3), sort: (e) => arr(e.stats).length || null, dir: 'desc' },
        { key: 'users', label: 'col.users', cls: 'num', dir: 'desc', cell: (e) => fmtNum(essenceUsers(e).length), sort: (e) => essenceUsers(e).length },
        colFirst(), colChapters()],
      filters: [gradeFilter(), enumFilter('color', 'f.color', (e) => arr(e.colors).map(colorVal), (v) => colorName(v), (v) => { const i = COLORS.indexOf(v); return i < 0 ? 99 : i; }),
        boolFilter('user', 'f.hasUser', (e) => essenceUsers(e).length > 0, 'opt.hasUsers', 'opt.noUsers')],
      extra: (e) => arr(e.colors).concat(arr(e.passive).map((p) => p && p.name), arr(e.actives).map((a) => a && a.name)),
    },
    skills: {
      columns: [Object.assign(colName(), { cell: (e, cat) => { const n = stagesOf(e).length; return html`${entLink(cat, e)}${n ? html` <span class="badge dim stg">${n === 1 ? T('skill.stage1') : T('skill.stages', { n })}</span>` : ''}`; } }),
        colEnum('kind', 'col.kind', (e) => e.kind),
        { key: 'source', label: 'col.source', cell: (e) => sourceHtml(e.source), sort: (e) => sourceName(e.source) || null },
        { key: 'users', label: 'col.users', cls: 'wide', cell: (e) => refListShort(skillUsers(e).map((u) => u.who), ['characters'], 3), sort: (e) => skillUsers(e).length || null, dir: 'desc' },
        { key: 'cost', label: 'col.cost', cell: (e) => tx(e.cost, true), sort: (e) => t(e.cost) || null },
        { key: 'cooldown', label: 'col.cooldown', cell: (e) => tx(e.cooldown, true), sort: (e) => t(e.cooldown) || null },
        colChapters()],
      filters: [enumFilter('kind', 'f.kind', (e) => e.kind), enumFilter('src', 'f.source', (e) => e.source && e.source.type)],
      extra: (e) => [e.kind, sourceName(e.source)],
    },
    items: {
      columns: [
        { key: 'number', label: 'col.number', cls: 'nowrap', cell: (e) => (e.number ? html`<span class="badge amber">${e.number}</span>` : ''), sort: (e) => numberSort(e.number) },
        colName(), colEnum('category', 'col.category', (e) => e.category),
        { key: 'grade', label: 'col.grade', cls: 'center', cell: (e) => gradeBadge(e.grade), sort: (e) => (toInt(e.grade) != null ? toInt(e.grade) : (e.grade || null)) },
        { key: 'material', label: 'col.material', cell: (e) => tx(e.material, true), sort: (e) => t(e.material) || null },
        { key: 'price', label: 'col.price', cell: (e) => tx(e.price, true), sort: (e) => t(e.price) || null },
        { key: 'owners', label: 'col.owners', cell: (e) => refListShort(itemOwners(e).map((o) => o.who), ['characters'], 2), sort: (e) => itemOwners(e).length || null, dir: 'desc' },
        colChapters()],
      filters: [enumFilter('category', 'f.category', (e) => e.category),
        boolFilter('num', 'f.numbered', (e) => !!(e.number && String(e.number).trim()), 'opt.numbered', 'opt.notNumbered')],
      extra: (e) => [e.number, e.category],
    },
    locations: {
      columns: [colName(), colEnum('kind', 'col.kind', (e) => e.kind),
        { key: 'floor', label: 'col.floor', cls: 'nowrap', cell: (e) => (locFloor(e) ? floorLabel(locFloor(e)) : ''), sort: (e) => (locFloor(e) ? floorOrder(floorKey(locFloor(e))) : null) },
        { key: 'parent', label: 'col.parent', cell: (e) => { const p = R.parentOf.get(e.id); return p ? entLink('locations', p, true) : (e.parent ? refHtml(e.parent, ['locations'], true) : ''); }, sort: (e) => { const p = R.parentOf.get(e.id); return p ? plainName(p) : null; } },
        { key: 'monsters', label: 'col.monsters', cls: 'num', dir: 'desc', cell: (e) => fmtNum(monstersAt(e).length), sort: (e) => monstersAt(e).length },
        colFirst(), colChapters()],
      filters: [enumFilter('kind', 'f.kind', (e) => e.kind), floorFilter((e) => locFloor(e))],
      extra: (e) => [e.kind],
    },
    factions: {
      columns: [colName(), colEnum('kind', 'col.kind', (e) => e.kind),
        { key: 'leader', label: 'col.leader', cell: (e) => refHtml(e.leader, ['characters'], true), sort: (e) => { if (!e.leader) return null; const r = resolveE(e.leader, 'characters'); return r ? plainName(r) : String(e.leader); } },
        { key: 'members', label: 'col.members', cls: 'num', dir: 'desc', cell: (e) => fmtNum(factionMembers(e).length), sort: (e) => factionMembers(e).length },
        colFirst(), colChapters()],
      filters: [enumFilter('kind', 'f.kind', (e) => e.kind)],
      extra: (e) => [e.kind],
    },
    lore: {
      columns: [colName('col.title'), colEnum('topic', 'col.topic', (e) => e.topic), colFirst(), colChapters()],
      filters: [enumFilter('topic', 'f.topic', (e) => e.topic)],
      extra: (e) => [e.topic],
    },
  };

  /** Text-filter haystack per entity (names in both languages, aliases, id, extra fields). */
  const HAY = new Map();
  function hay(cat, e) {
    const k = cat + '|' + e.id;
    let h = HAY.get(k);
    if (h == null) {
      const extra = CATDEF[cat].extra ? CATDEF[cat].extra(e) : [];
      h = [e.name, e.name_th, e.title, e.title_th, e.id].concat(arr(e.aliases), arr(extra))
        .filter((x) => x != null && x !== '').map((x) => norm(typeof x === 'object' ? t(x) : x)).join(' | ');
      HAY.set(k, h);
    }
    return h;
  }

  /* =================================================================
   * 7b. Detail pages — one renderer per category. All share detailShell():
   *     breadcrumb, name header (+ the other-language name), badges, an
   *     info box, sections (empty ones are hidden), then "Appears in chapters".
   * ================================================================= */
  function detailShell(cat, e, parts) {
    const toc = TOC || [];
    TOC = null;
    const p = headNames(e);
    const aliases = arr(e.aliases).filter((a) => a != null && String(a).trim() !== '');
    const info = infobox((parts.info || []).concat([[T('lbl.id'), html`<code>${e.id}</code>`]]));
    const trail = parts.crumbs || [[T('nav.home'), '#/'], [T('cat.' + cat), '#/' + cat], [p.main]];
    return html`
      ${crumbs(trail)}
      <header class="ent-head">
        <h1 class="ent-name">${p.main}${p.alt ? html`<span class="ent-alt" lang="${lang === 'th' ? 'en' : 'th'}">${p.alt}</span>` : ''}</h1>
        ${!blank(parts.badges) ? html`<div class="badges">${parts.badges}</div>` : ''}
        ${aliases.length ? html`<p class="aka">${T('lbl.aliases')}: <span>${capList(aliases, 12)}</span></p>` : ''}
      </header>
      <div class="ent-grid">
        <aside class="ent-side" aria-label="${T('lbl.infobox')}">${info}${tocNav(toc.concat([['appears', esc(T('sec.appears'))]]))}</aside>
        <div class="ent-main">${parts.main}${appearsIn(e.refs)}</div>
      </div>`;
  }
  const badge = (text, cls) => (text ? html`<span class="badge${cls ? ' ' + cls : ''}">${text}</span>` : '');
  const firstRow = (e, first) => { const n = toInt(first) || (e.refs.length ? e.refs[0] : null); return [T('lbl.first'), n ? chChip(n) : '']; };
  const linkCell = (v, cats) => refHtml(v, cats);
  function floorLinks(floors) {
    return joinHtml(arr(floors).map((f) => { const l = R.floorLoc.get(floorKey(f)); return l ? html`<a href="${href('locations', l.id)}">${floorLabel(f)}</a>` : floorLabel(f); }));
  }
  /** People table: who / chapter / note (essence users, item owners …). */
  function peopleTable(list) {
    return miniTable([{ label: T('th.character') }, { label: T('th.chapter'), cls: 'nowrap' }, { label: T('th.note') }],
      list.map((u) => [linkCell(u.who, ['characters']), chCell(u.ch), tx(u.note)]));
  }
  /** Character rows: name / race / roles / status, used by race and faction pages. */
  function charTable(chars, noRace) {
    const cols = [{ label: T('th.name') }].concat(noRace ? [] : [{ label: T('th.race') }], [{ label: T('th.roles') }, { label: T('th.status') }]);
    return miniTable(cols, chars.map((c) => {
      const ok = typeof c === 'object' && c.id;
      const race = noRace ? [] : [ok ? refHtml(c.race, ['races'], true) : ''];
      return ok ? [entLink('characters', c)].concat(race, [joinHtml(arr(c.roles).map((r) => tx(r, true))), statusBadge(c.status)])
        : [refHtml(c, ['characters'])].concat(race, ['', '']);
    }));
  }

  function essencePreview(es) {
    const stats = arr(es.stats).filter((s) => s && (s.stat || s.value != null));
    const passive = arr(es.passive).filter((p) => p && p.name);
    const actives = arr(es.actives).filter((a) => a && a.name);
    return html`<div class="preview">
      <div class="preview-head">${entLink('essences', es)} ${gradeOrMix(es, true)} ${arr(es.colors).map((c) => swatch(c, true))}</div>
      ${stats.length || passive.length || actives.length ? html`<dl>
        ${stats.length ? html`<dt>${T('sec.stats')}</dt><dd>${statsInline(stats)}</dd>` : ''}
        ${passive.length ? html`<dt>${T('sec.passive')}</dt><dd>${joinHtml(passive.map((p) => skillName(p.name, es.id)))}</dd>` : ''}
        ${actives.length ? html`<dt>${T('sec.activeShort')}</dt><dd class="statline">${actives.map((a) => html`<span class="swc">${swatch(a.color)} ${skillName(a.name, es.id)}</span>`)}</dd>` : ''}
      </dl>` : ''}
    </div>`;
  }

  const DETAIL = {};

  DETAIL.monsters = function (e) {
    const es = R.essOfMon.get(e.id);
    const floors = arr(e.floors);
    return detailShell('monsters', e, {
      badges: [gradeBadge(e.grade, true), badge(enumLabel(e.category)), floors.map((f) => badge(floorLabel(f)))],
      info: [
        [T('lbl.grade'), gradeBadge(e.grade, true)],
        [T('lbl.category'), enumLabel(e.category)],
        [T('lbl.floors'), floorLinks(floors)],
        [T('lbl.zones'), capList(arr(e.zones).map((z) => refHtml(z, ['locations'])), 6)],
        [T('lbl.essence'), es ? entLink('essences', es) : refHtml(e.essence, ['essences'])],
        [T('lbl.exp'), expHtml(e)],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('appearance', T('sec.appearance'), block(e.appearance)),
        section('abilities', T('sec.abilities'), miniTable([{ label: T('th.ability') }, { label: T('th.effect') }],
          arr(e.abilities).filter((a) => a && (a.name || hasText(a.desc))).map((a) => [html`<strong>${a.name || ''}</strong>`, tx(a.desc)]))),
        section('weakness', T('sec.weakness'), block(e.weakness)),
        section('behavior', T('sec.behavior'), block(e.behavior)),
        section('drops', T('sec.drops'), html`${dropsTable(e)}${block(e.drops)}`),
        section('essence', T('sec.essence'), es ? essencePreview(es) : ''),
        section('encounters', T('sec.encounters'), timeline(e.encounters)),
      ],
    });
  };

  DETAIL.essences = function (e) {
    const mon = R.monOfEss.get(e.id);
    const users = essenceUsers(e);
    const actives = arr(e.actives).filter((a) => a && (a.name || hasText(a.desc)));
    const hasTrans = actives.some((a) => hasText(a.transcendence));
    const passives = arr(e.passive).filter((p) => p && (p.name || hasText(p.desc)));
    const cols = [{ label: T('th.colour'), cls: 'nowrap' }, { label: T('th.skill') }, { label: T('th.effect') }].concat(hasTrans ? [{ label: T('th.trans') }] : []);
    return detailShell('essences', e, {
      badges: [gradeOrMix(e, true), arr(e.colors).map((c) => html`<span class="badge">${swatch(c, true)}</span>`)],
      info: [
        [T('lbl.monster'), mon ? entLink('monsters', mon) : refHtml(e.monster, ['monsters'])],
        [T('lbl.madeFrom'), madeFromHtml(e)],
        [T('lbl.grade'), gradeOrMix(e, true)],
        [T('lbl.colors'), html`<span class="statline">${arr(e.colors).map((c) => swatch(c, true))}</span>`],
        [T('lbl.users'), users.length ? fmtNum(users.length) : ''],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('stats', T('sec.stats'), miniTable([{ label: T('th.stat') }, { label: T('th.value'), cls: 'num' }],
          arr(e.stats).filter((s) => s && (s.stat || s.value != null)).map((s) => [tx(s.stat), statVal(s.value)]))),
        section('passive', T('sec.passive'), passives.map((p) => html`<div class="ability"><h3>${skillName(p.name, e.id)}</h3>${block(p.desc)}${hasText(p.transcendence) ? html`<p class="small"><span class="muted">${T('th.trans')}:</span> ${tx(p.transcendence)}</p>` : ''}</div>`)),
        section('actives', T('sec.actives'), miniTable(cols, actives.map((a) => [swatch(a.color, true), html`<strong>${skillName(a.name, e.id)}</strong>`, tx(a.desc)].concat(hasTrans ? [tx(a.transcendence)] : [])))),
        section('users', T('sec.users'), peopleTable(users)),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.characters = function (e) {
    const race = e.race ? resolveE(e.race, 'races') : null;
    const essRows = arr(e.essences).map((x) => (typeof x === 'object' && x ? x : { essence: x })).filter((x) => x.essence)
      .sort((a, b) => (toInt(a.ch) || 1e9) - (toInt(b.ch) || 1e9))
      .map((x) => { const es = resolveE(x.essence, 'essences'); const nm = refHtml(x.essence, ['essences']); return [x.removed ? html`<del class="rm">${nm}</del>` : nm, es ? gradeOrMix(es) : '', chCell(x.ch), tx(x.note)]; });
    const skillRows = arr(e.skills).map((s) => { const sk = resolveE(s, 'skills'); return [refHtml(s, ['skills']), sk ? enumLabel(sk.kind) : '', sk ? sourceHtml(sk.source) : '']; });
    const itemRows = arr(e.items).map((i) => { const it = resolveE(i, 'items'); return [it && it.number ? badge(it.number, 'amber') : '', refHtml(i, ['items']), it ? enumLabel(it.category) : '']; });
    const relRows = arr(e.relationships).filter((r) => r && r.who).map((r) => [refHtml(r.who, ['characters']), tx(r.rel)]);
    return detailShell('characters', e, {
      badges: [race ? badge(plainName(race)) : badge(e.race ? prettyId(e.race) : ''), statusBadge(e.status),
        badge(impLabel(e.importance), toInt(e.importance) === 1 ? 'amber' : ''), isEvil(e) ? badge(T('lbl.evil'), 'crimson') : ''],
      info: [
        [T('lbl.race'), refHtml(e.race, ['races'])],
        [T('lbl.gender'), enumLabel(e.gender)],
        [T('lbl.level'), e.level != null && typeof e.level !== 'object' && String(e.level).trim() !== '' ? String(e.level) : ''],
        [T('lbl.roles'), capList(arr(e.roles).map((r) => tx(r)), 4, '<br>')],
        [T('lbl.affiliations'), capList(arr(e.affiliations).map((v) => refHtml(v, ['factions'])), 6)],
        [T('lbl.status'), statusBadge(e.status)],
        [T('lbl.evil'), e.evil_spirit == null ? '' : (isEvil(e) ? badge(T('yes'), 'crimson') : T('no'))],
        [T('lbl.mask'), tx(e.mask)],
        [T('lbl.importance'), impLabel(e.importance)],
        firstRow(e, e.first_ch),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('levels', T('sec.levels'), levelStrip(e.level_history)),
        section('appearance', T('sec.appearance'), block(e.appearance)),
        section('personality', T('sec.personality'), block(e.personality)),
        section('abilities', T('sec.abilities'), block(e.abilities)),
        section('essences', T('sec.essences'), miniTable([{ label: T('th.essence') }, { label: T('th.grade'), cls: 'center' }, { label: T('th.acquired'), cls: 'nowrap' }, { label: T('th.note') }], essRows)),
        section('skills', T('sec.skills'), miniTable([{ label: T('th.skill') }, { label: T('th.kind') }, { label: T('th.source') }], skillRows)),
        section('items', T('sec.items'), miniTable([{ label: T('th.number'), cls: 'nowrap' }, { label: T('th.item') }, { label: T('th.category') }], itemRows)),
        section('relationships', T('sec.relationships'), miniTable([{ label: T('th.character') }, { label: T('th.relation') }], relRows)),
        section('timeline', T('sec.timeline'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.races = function (e) {
    const members = (R.charsByRace.get(e.id) || []).slice()
      .sort((a, b) => ((toInt(a.importance) || 9) - (toInt(b.importance) || 9)) || collator.compare(plainName(a), plainName(b)));
    const abilities = arr(e.abilities).filter((a) => a && (a.name || hasText(a.desc)));
    return detailShell('races', e, {
      info: [
        [T('lbl.people'), members.length ? fmtNum(members.length) : ''],
        [T('lbl.notable'), arr(e.notable).length ? fmtNum(arr(e.notable).length) : ''],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('traits', T('sec.traits'), bullets(e.traits)),
        foldSection('abilities', T('sec.raceFeats'), abilities.map((a) => {
          const ex = arr(a.examples).filter((x) => x && (x.who || hasText(x.desc)))
            .sort((p, q) => (toInt(p.ch) || 1e9) - (toInt(q.ch) || 1e9))
            .map((x) => [refHtml(x.who, ['characters']), chCell(x.ch), tx(x.desc)]);
          return html`<div class="ability"><h3>${a.name || ''} <span class="count">${fmtNum(ex.length)}</span></h3>${block(a.desc)}${miniTable([{ label: T('th.character') }, { label: T('th.chapter'), cls: 'nowrap' }, { label: T('th.what') }], ex)}</div>`;
        }), T('feats.count', { n: fmtNum(abilities.reduce((n, a) => n + arr(a.examples).filter((x) => x && (x.who || hasText(x.desc))).length, 0)) })),
        section('roles', T('sec.roles'), bullets(e.roles)),
        section('culture', T('sec.culture'), block(e.culture)),
        section('homeland', T('sec.homeland'), arr(e.homeland).length ? html`<p class="linklist">${capList(arr(e.homeland).map((h) => refHtml(h, ['locations'])), 12, '')}</p>` : ''),
        section('notable', T('sec.notable'), arr(e.notable).length ? html`<p class="linklist">${capList(arr(e.notable).map((c) => refHtml(c, ['characters'])), 20, '')}</p>` : ''),
        section('members', T('sec.raceMembers'), charTable(members.slice(0, 300), true)),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.skills = function (e) {
    const users = skillUsers(e);
    const src = e.source && typeof e.source === 'object' ? e.source : null;
    const srcEss = src && norm(src.type) === 'essence' ? resolveE(src.id || src.name, 'essences') : null;
    return detailShell('skills', e, {
      badges: [badge(enumLabel(e.kind)), src && src.type ? badge(enumLabel(src.type), 'dim') : ''],
      info: [
        [T('lbl.kind'), enumLabel(e.kind)],
        [T('lbl.source'), sourceHtml(e.source, true)],
        [T('lbl.cost'), tx(e.cost)],
        [T('lbl.cooldown'), tx(e.cooldown)],
        [T('lbl.users'), users.length ? fmtNum(users.length) : ''],
        firstRow(e),
      ],
      main: [
        // curated skills can carry both an overview (summary) and a short definition (desc): show both
        section('summary', T('sec.summary'), block(e.summary)),
        section('desc', T('sec.description'), t(e.desc).trim() && t(e.desc).trim() === t(e.summary).trim() ? '' : block(e.desc)),
        customSections(e),
        section('stages', T('sec.stages'), stagesTable(e)),
        section('source', T('sec.source'), srcEss ? essencePreview(srcEss) : ''),
        section('users', T('sec.skillUsers'), users.length ? html`<p class="linklist">${capList(users.map((u) => refHtml(u.who, ['characters'])), 24, '')}</p>` : ''),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.items = function (e) {
    const owners = itemOwners(e);
    return detailShell('items', e, {
      badges: [e.number ? badge(e.number, 'amber') : '', badge(enumLabel(e.category)), gradeBadge(e.grade, true)],
      info: [
        [T('lbl.number'), e.number ? badge(e.number, 'amber') : ''],
        [T('lbl.category'), enumLabel(e.category)],
        [T('lbl.grade'), gradeBadge(e.grade, true)],
        [T('lbl.material'), tx(e.material)],
        [T('lbl.price'), tx(e.price)],
        [T('lbl.owners'), owners.length ? fmtNum(owners.length) : ''],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('effects', T('sec.effects'), block(e.effects)),
        section('owners', T('sec.owners'), peopleTable(owners)),
        section('obtained', T('sec.obtained'), block(e.obtained)),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.locations = function (e) {
    const anc = ancestors(e);
    const kids = sortLocs(R.children.get(e.id) || []);
    // weakest first (grade 9 … 1), unknown grades last
    const mons = monstersAt(e).slice().sort((a, b) => ((toInt(b.grade) || 0) - (toInt(a.grade) || 0)) || collator.compare(plainName(a), plainName(b)));
    const fl = locFloor(e);
    const p = headNames(e);
    return detailShell('locations', e, {
      crumbs: [[T('nav.home'), '#/'], [T('nav.maps'), '#/maps']].concat(anc.map((a) => [plainName(a), href('locations', a.id)]), [[p.main]]),
      badges: [badge(enumLabel(e.kind), slug(e.kind) === 'rift' ? 'crimson' : ''), fl ? badge(floorLabel(fl)) : ''],
      info: [
        [T('lbl.kind'), enumLabel(e.kind)],
        [T('lbl.floor'), fl ? floorLinks([fl]) : ''],
        [T('lbl.parent'), anc.length ? entLink('locations', anc[anc.length - 1]) : refHtml(e.parent, ['locations'])],
        [T('lbl.path'), anc.length > 1 ? joinHtml(anc.map((a) => entLink('locations', a, true)), raw(' <span class="muted">›</span> ')) : ''],
        [T('lbl.inside'), kids.length ? fmtNum(kids.length) : ''],
        [T('lbl.monsters'), mons.length ? fmtNum(mons.length) : ''],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('features', T('sec.features'), bullets(e.features)),
        section('rules', T('sec.rules'), block(e.rules)),
        section('inside', T('sec.inside'), miniTable([{ label: T('th.name') }, { label: T('th.kind') }],
          kids.map((k) => [entLink('locations', k), enumLabel(k.kind)]))),
        section('monsters', T('sec.monstersHere'), miniTable([{ label: T('th.monster') }, { label: T('th.grade'), cls: 'center' }, { label: T('th.category') }],
          mons.map((m) => [entLink('monsters', m), gradeBadge(m.grade) || dash(), enumLabel(m.category)]))),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.factions = function (e) {
    const members = factionMembers(e).map((m) => { const r = resolve(m.who, ['characters']); return r ? r.e : m.who; });
    return detailShell('factions', e, {
      badges: [badge(enumLabel(e.kind))],
      info: [
        [T('lbl.kind'), enumLabel(e.kind)],
        [T('lbl.leader'), refHtml(e.leader, ['characters'])],
        [T('lbl.members'), members.length ? fmtNum(members.length) : ''],
        firstRow(e),
      ],
      main: [
        section('summary', T('sec.summary'), block(e.summary)),
        customSections(e),
        section('members', T('sec.members'), charTable(members)),
        section('history', T('sec.history'), timeline(e.timeline)),
      ],
    });
  };

  DETAIL.lore = function (e) {
    return detailShell('lore', e, {
      badges: [badge(enumLabel(e.topic))],
      info: [[T('lbl.topic'), enumLabel(e.topic)], firstRow(e)],
      main: [section('body', T('sec.body'), block(e.body, 'long')), customSections(e)],
    });
  };

  /* =================================================================
   * 8. Views. Each returns {title, nav, html, mount?(root)}.
   * ================================================================= */
  const PAGE_SIZE = 100;

  /* ---------- list pages: #/monsters?q=&grade=3&sort=grade&dir=desc&page=2 ---------- */
  function readListState(def, params) {
    const sort0 = def.defaultSort || 'name';
    const sortKey = params.get('sort');
    const col = def.columns.find((c) => c.key === sortKey);
    const st = {
      q: (params.get('q') || '').trim(),
      sort: col ? sortKey : sort0,
      dir: params.get('dir') === 'desc' ? 'desc' : params.get('dir') === 'asc' ? 'asc' : null,
      page: Math.max(1, toInt(params.get('page')) || 1),
      f: {},
    };
    if (!st.dir) st.dir = defaultDir(def, st.sort);
    for (const f of def.filters) { const v = params.get(f.key); if (v != null && v !== '') st.f[f.key] = v; }
    return st;
  }
  function defaultDir(def, key) { const c = def.columns.find((x) => x.key === key); return c && c.dir === 'desc' ? 'desc' : 'asc'; }
  function listHash(cat, def, st) {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    for (const f of def.filters) if (st.f[f.key]) p.set(f.key, st.f[f.key]);
    if (st.sort !== (def.defaultSort || 'name')) p.set('sort', st.sort);
    if (st.dir !== defaultDir(def, st.sort)) p.set('dir', st.dir);
    if (st.page > 1) p.set('page', String(st.page));
    const qs = p.toString();
    return '#/' + cat + (qs ? '?' + qs : '');
  }
  /** Empty values always sort last, whatever the direction. */
  function cmpVals(a, b, dir) {
    const an = a == null || a === '', bn = b == null || b === '';
    if (an || bn) return an && bn ? 0 : an ? 1 : -1;
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
    return collator.compare(String(a), String(b)) * dir;
  }
  function runList(cat, st) {
    const def = CATDEF[cat];
    let rows = D[cat];
    if (st.q) {
      const toks = norm(st.q).split(' ').filter(Boolean);
      rows = rows.filter((e) => { const h = hay(cat, e); return toks.every((tk) => h.includes(tk)); });
    }
    for (const f of def.filters) { const v = st.f[f.key]; if (v) rows = rows.filter((e) => f.test(e, v)); }
    const col = def.columns.find((c) => c.key === st.sort) || def.columns[0];
    const dir = st.dir === 'desc' ? -1 : 1;
    const keyed = rows.map((e) => [col.sort(e), plainName(e), e]);
    keyed.sort((a, b) => cmpVals(a[0], b[0], dir) || collator.compare(a[1], b[1]));
    return keyed.map((x) => x[2]);
  }
  function pageList(page, pages) {
    const set = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
    const nums = Array.from(set).filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push(0); out.push(n); });
    return out;
  }
  function renderPager(page, pages) {
    if (pages <= 1) return '';
    return html`<button type="button" class="pg" data-page="${page - 1}"${page <= 1 ? raw(' disabled') : ''} aria-label="${T('list.prev')}">${icon('chevL')}<span>${T('list.prev')}</span></button>
      ${pageList(page, pages).map((n) => (n === 0 ? html`<span class="pg-gap" aria-hidden="true">…</span>`
        : html`<button type="button" class="pg${n === page ? ' on' : ''}" data-page="${n}"${n === page ? raw(' aria-current="page"') : ''}>${n}</button>`))}
      <button type="button" class="pg" data-page="${page + 1}"${page >= pages ? raw(' disabled') : ''} aria-label="${T('list.next')}"><span>${T('list.next')}</span>${icon('chevR')}</button>`;
  }
  function renderHead(def, st) {
    return html`<tr>${def.columns.map((c) => {
      const on = st.sort === c.key;
      return html`<th class="${c.cls || ''}" aria-sort="${on ? (st.dir === 'desc' ? 'descending' : 'ascending') : 'none'}"><button type="button" data-sort="${c.key}">${T(c.label)}${on ? icon(st.dir === 'desc' ? 'chevD' : 'chevU', 'sort-ind') : ''}</button></th>`;
    })}</tr>`;
  }

  function viewList(cat, params) {
    const def = CATDEF[cat];
    const all = D[cat];
    const st = readListState(def, params);
    const catName = lang === 'en' ? T('cat.' + cat).toLowerCase() : T('cat.' + cat);
    const fields = def.filters.map((f) => {
      const opts = f.options(all);
      const cur = st.f[f.key];
      if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, label: cur, count: 0 });
      return html`<label class="field${cur ? ' active' : ''}"><span>${T(f.label)}</span><select name="${f.key}"><option value="">${T('list.any')}</option>${opts.map((o) => html`<option value="${o.value}"${cur === o.value ? raw(' selected') : ''}>${o.label} (${fmtNum(o.count)})</option>`)}</select></label>`;
    });
    return {
      title: T('cat.' + cat), nav: NAV_OF[cat],
      html: html`
        <div class="page-head"><h1>${T('cat.' + cat)}</h1><p class="lede">${T('lede.' + cat)}${cat === 'locations' ? html` <a href="#/maps">${T('list.mapLink')}</a>` : ''}</p></div>
        ${all.length ? html`
          <form class="filters" data-list-form autocomplete="off" role="search">
            <label class="field grow"><span>${T('list.search')}</span><input type="search" name="q" value="${st.q}" placeholder="${T('list.searchPh')}" spellcheck="false"></label>
            ${fields}
            <button type="button" class="btn" data-act="clear">${T('list.clear')}</button>
          </form>
          <div class="list-meta"><span data-count aria-live="polite"></span><span>${T('list.sortHint')}</span></div>
          <div class="table-wrap"><table class="db"><thead></thead><tbody></tbody></table></div>
          <nav class="pager" aria-label="${T('list.pages')}"></nav>`
        : html`<div class="panel empty">${T('list.emptyNone', { cat: catName })}</div>`}`,
      mount(root) { if (all.length) mountList(root, cat, def, st); },
    };
  }

  /** Wires a list page: filtering/sorting/paging re-render only the table and
   *  write the state into the URL with replaceState (no history spam). */
  function mountList(root, cat, def, st) {
    const form = $('[data-list-form]', root), thead = $('thead', root), tbody = $('tbody', root);
    const count = $('[data-count]', root), pager = $('.pager', root), meta = $('.list-meta', root);
    let rows = [];
    const recompute = () => { rows = runList(cat, st); };
    function paint() {
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (st.page > pages) st.page = pages;
      const start = (st.page - 1) * PAGE_SIZE;
      const slice = rows.slice(start, start + PAGE_SIZE);
      thead.innerHTML = toHtml(renderHead(def, st));
      tbody.innerHTML = slice.length
        ? toHtml(slice.map((e) => html`<tr data-href="${href(cat, e.id)}">${def.columns.map((c) => html`<td class="${c.cls || ''}">${c.cell(e, cat)}</td>`)}</tr>`))
        : toHtml(html`<tr><td colspan="${def.columns.length}"><div class="empty">${T('list.emptyFiltered')}<br><button type="button" class="btn" data-act="clear">${T('list.clear')}</button></div></td></tr>`);
      const total = D[cat].length;
      const filtered = !!(st.q || Object.keys(st.f).length);
      const main = filtered ? T('list.countOf', { n: fmtNum(rows.length), total: fmtNum(total) }) : total === 1 ? T('list.count1') : T('list.count', { n: fmtNum(total) });
      count.innerHTML = toHtml(html`<strong>${main}</strong>${pages > 1 ? html`, ${T('list.showing', { a: fmtNum(start + 1), b: fmtNum(Math.min(rows.length, start + PAGE_SIZE)) })}` : ''}`);
      pager.innerHTML = toHtml(renderPager(st.page, pages));
      replaceHash(listHash(cat, def, st));
    }
    recompute(); paint();
    const onText = debounce(() => { st.q = form.elements.q.value.trim(); st.page = 1; recompute(); paint(); }, 120);
    form.addEventListener('input', (ev) => { if (ev.target.name === 'q') onText(); });
    form.addEventListener('submit', (ev) => ev.preventDefault());
    form.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!el.name || el.name === 'q') return;
      if (el.value) st.f[el.name] = el.value; else delete st.f[el.name];
      el.closest('.field').classList.toggle('active', !!el.value);
      st.page = 1; recompute(); paint();
    });
    root.addEventListener('click', (ev) => {
      const sb = ev.target.closest('[data-sort]');
      if (sb) {
        const k = sb.getAttribute('data-sort');
        if (st.sort === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = k; st.dir = defaultDir(def, k); }
        st.page = 1; recompute(); paint();
        const again = $('[data-sort="' + k + '"]', thead); if (again) again.focus();
        return;
      }
      const pb = ev.target.closest('[data-page]');
      if (pb && !pb.disabled) {
        st.page = toInt(pb.getAttribute('data-page')) || 1; paint();
        meta.scrollIntoView({ block: 'start' });
        return;
      }
      if (ev.target.closest('[data-act="clear"]')) {
        st.q = ''; st.f = {}; st.page = 1;
        form.elements.q.value = '';
        $$('select', form).forEach((s) => { s.value = ''; s.closest('.field').classList.remove('active'); });
        recompute(); paint();
      }
    });
  }

  /* ---------- home ---------- */
  function gradeLadder() {
    const steps = [];
    for (let g = 9; g >= 1; g--) steps.push(html`<div class="step g${g}" style="--h:${9 - g}" title="${T('grade.n', { n: g })}">${g}</div>`);
    return html`<div class="ladder" role="img" aria-label="${T('home.gradesNote')}">${steps}</div>
      <div class="ladder-ends"><span>${T('grade.weakest')}</span><span>${T('grade.strongest')}</span></div>`;
  }
  function coverageBar() {
    const total = D.meta.chapters_total;
    const runs = [];
    let start = null, prev = null;
    for (const n of CH_NUMS) {
      if (start != null && n === prev + 1) { prev = n; continue; }
      if (start != null) runs.push([start, prev]);
      start = prev = n;
    }
    if (start != null) runs.push([start, prev]);
    const rects = runs.map(([a, b]) => '<rect class="have" x="' + (a - 1) + '" y="0" width="' + Math.max(2, b - a + 1) + '" height="10"/>').join('')
      + D.meta.chapters_missing.map((n) => '<rect class="miss" x="' + (n - 1) + '" y="0" width="2" height="10"/>').join('');
    return html`<svg class="covbar" viewBox="0 0 ${total} 10" preserveAspectRatio="none" role="img" aria-label="${T('story.coverage', { have: fmtNum(D.chapters.length), total: fmtNum(total) })}">${raw(rects)}</svg>
      <div class="cov-legend"><span><i style="background:var(--amber)"></i>${T('cov.have')}</span><span><i style="background:var(--crimson)"></i>${T('cov.missLegend')}</span></div>`;
  }
  function homeExamples() {
    const ex = [];
    const c = D.characters.slice().sort((a, b) => (toInt(a.importance) || 9) - (toInt(b.importance) || 9))[0];
    if (c) ex.push(plainName(c));
    const m = D.monsters.find((x) => toInt(x.grade) != null) || D.monsters[0];
    if (m) ex.push(plainName(m));
    if (D.chapters.length) ex.push(String(D.chapters[D.chapters.length - 1].n));
    const thLoc = D.locations.find((l) => l.name_th);
    if (thLoc) ex.push(thLoc.name_th);
    return Array.from(new Set(ex)).slice(0, 4);
  }
  function viewHome() {
    const m = D.meta;
    const tiles = [{ key: 'story', href: '#/story', icon: 'story', count: D.chapters.length, label: T('cat.chapters'), hint: T('tile.story') }]
      .concat(CATS.map((c) => ({ key: c, href: c === 'locations' ? '#/maps' : '#/' + c, icon: c, count: D[c].length, label: T('cat.' + c), hint: T('tile.' + c) })));
    const total = m.chapters_total;
    return {
      title: '', nav: 'home',
      html: html`
        <section class="hero">
          <h1 class="hero-title">${m.title || 'Barbarian Codex'}</h1>
          ${hasText(m.subtitle) ? html`<p class="hero-sub">${t(m.subtitle)}</p>` : ''}
          <p class="hero-intro">${T('home.intro')}</p>
          <form class="hero-search" data-home-search role="search" autocomplete="off">
            <label class="box" for="home-q">${icon('search')}<span class="sr">${T('search.label')}</span>
              <input id="home-q" type="search" placeholder="${T('search.placeholder')}" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="home-pop" aria-autocomplete="list"></label>
            <button type="submit" class="btn primary">${T('home.searchBtn')}</button>
            <div class="sbox-pop" id="home-pop" role="listbox" hidden></div>
          </form>
          ${homeExamples().length ? html`<p class="try">${T('home.try')}: ${homeExamples().map((q) => html`<a class="chip" href="#/search?q=${encodeURIComponent(q)}">${q}</a>`)}</p>` : ''}
        </section>
        <section aria-label="${T('home.browse')}"><div class="tiles">${tiles.map((x) => html`
          <a class="tile" href="${x.href}">${icon(x.icon)}<span class="cnt">${fmtNum(x.count)}</span><span class="lbl">${x.label}</span><span class="hint">${x.hint}</span></a>`)}</div></section>
        <div class="home-grid">
          <section class="panel how"><h2>${T('home.how')}</h2><ul>
            <li>${T('how.search')}</li><li>${T('how.lists')}</li><li>${T('how.links')}</li><li>${T('how.story')}</li><li>${T('how.lang')}</li>
          </ul></section>
          <section class="panel"><h2>${T('home.grades')}</h2>${gradeLadder()}<p class="small muted">${T('home.gradesNote')}</p>
            <h3>${T('home.colors')}</h3><div class="sw-legend">${COLORS.map((c) => swatch(c, true))}</div></section>
          <section class="panel"><h2>${T('home.coverage')}</h2>
            <dl class="kv">
              <dt>${T('cov.range')}</dt><dd>1–${fmtNum(total)}</dd>
              <dt>${T('cov.missing')}</dt><dd>${m.chapters_missing.length ? m.chapters_missing.join(', ') : T('cov.none')}</dd>
              ${m.chapters_partial.length ? html`<dt>${T('cov.partial')}</dt><dd>${joinHtml(m.chapters_partial.map((x) => html`<a href="#/chapter/${x.n}">${x.n}</a>`), ', ')}</dd>` : ''}
              <dt>${T('cov.inDb')}</dt><dd>${fmtNum(D.chapters.length)}</dd>${D.meta && D.meta.chapters_summarized ? `<dt>${T('cov.sum')}</dt><dd>${fmtNum(D.meta.chapters_summarized)}</dd>` : ''}
              ${m.version ? html`<dt>${T('cov.version')}</dt><dd>${m.version}</dd>` : ''}
              ${m.generated ? html`<dt>${T('cov.generated')}</dt><dd>${m.generated}</dd>` : ''}
            </dl>
            ${coverageBar()}
            ${hasText(m.note) ? html`<p class="small muted">${tx(m.note)}</p>` : ''}
          </section>
        </div>`,
      mount(root) {
        const form = $('[data-home-search]', root);
        attachSearchBox($('#home-q', root), null, $('#home-pop', root));
        form.addEventListener('submit', (ev) => { ev.preventDefault(); submitSearch($('#home-q', root).value, 'all'); });
      },
    };
  }

  /* ---------- detail route ---------- */
  function viewDetail(cat, id) {
    let e = BY_ID[cat].get(id);
    if (!e) { const r = resolve(id, [cat]); if (r) e = r.e; }   // tolerate links by name or slug
    if (!e) return viewMissing(cat, id);
    TOC = [];
    let out;
    try { out = DETAIL[cat](e); } finally { TOC = null; }
    return { title: plainName(e), nav: NAV_OF[cat], html: out };
  }
  function viewMissing(cat, id) {
    const sim = runSearch(prettyId(id), cat, 8);
    const items = sim.flat;
    return {
      title: T('nf.title'), nav: NAV_OF[cat],
      html: html`${crumbs([[T('nav.home'), '#/'], [T('cat.' + cat), '#/' + cat], [id]])}
        <div class="page-head"><h1>${T('nf.title')}</h1><p class="lede">${T('nf.entity', { what: T('one.' + cat), id })}</p></div>
        ${items.length ? html`<h2 class="small muted">${T('nf.similar')}</h2><ul class="sr-list">${items.map((x) => html`<li>${hitLink(x)}<span class="ds">${describe(x.cat, x.e)}</span></li>`)}</ul>` : ''}
        <p style="margin-top:16px"><a class="btn" href="#/${cat}">${T('nf.back', { cat: T('cat.' + cat) })}</a></p>`,
    };
  }

  /* ---------- maps: Labyrinth diagram + location tree ---------- */
  function monCount(n) { return n === 1 ? T('maps.mon1') : T('maps.mon', { n: fmtNum(n) }); }
  function zoneChip(l) {
    const k = slug(l.kind || 'zone');
    const cls = k === 'rift' ? 'rift' : k === 'hidden-field' ? 'hidden-field' : k === 'island' ? 'island' : '';
    return html`<a class="zchip ${cls}" href="${href('locations', l.id)}" title="${enumLabel(l.kind)}"><span class="k" aria-hidden="true"></span>${nameHtml(l)}</a>`;
  }
  function zonesOnFloor(k, floorLoc) {
    const out = new Map();
    if (floorLoc) for (const d of descendants(floorLoc)) out.set(d.id, d);
    for (const l of D.locations) if (l !== floorLoc && !isFloorKind(l.kind) && floorKey(locFloor(l)) === k) out.set(l.id, l);
    return sortLocs(Array.from(out.values()));
  }
  function labyrinthDiagram() {
    const keys = new Set([...R.floorLoc.keys(), ...R.monByFloor.keys()]);
    for (const l of D.locations) { const k = floorKey(locFloor(l)); if (k) keys.add(k); }
    const list = Array.from(keys).filter((k) => /^u?\d+$/.test(k));
    const nums = list.filter((k) => /^\d+$/.test(k)).map(Number);
    const max = nums.length ? Math.max.apply(null, nums) : 0;
    for (let i = 1; i <= max; i++) if (list.indexOf(String(i)) < 0) list.push(String(i));   // keep the stack continuous
    list.sort((a, b) => floorOrder(a) - floorOrder(b));
    if (!list.length) return html`<p class="notice">${T('maps.noFloors')}</p>`;
    const maxMon = Math.max(1, ...list.map((k) => (R.monByFloor.get(k) || new Set()).size));
    const rows = [];
    let ug = false;
    list.forEach((k, i) => {
      if (k.charAt(0) === 'u' && !ug) { ug = true; rows.push(html`<div class="lab-divider">${T('maps.underground')}</div>`); }
      const fl = R.floorLoc.get(k);
      const zones = zonesOnFloor(k, fl);
      const mons = (R.monByFloor.get(k) || new Set()).size;
      const depth = list.length > 1 ? i / (list.length - 1) : 0;
      const num = k.charAt(0) === 'u' ? html`<span class="ug">U${k.slice(1)}</span>` : k;
      rows.push(html`<div class="lab-floor${i === list.length - 1 ? ' last' : ''}" style="--d:${depth.toFixed(3)};--i:${i}">
        <div class="lab-num">${fl ? html`<a href="${href('locations', fl.id)}" aria-label="${floorLabel(k)}">${num}</a>` : html`<span class="n">${num}</span>`}</div>
        <div class="lab-body">
          <div class="lab-title">${fl ? entLink('locations', fl) : html`<span>${floorLabel(k)}</span> <span class="lab-empty">${T('maps.floorMissing')}</span>`}</div>
          ${zones.length ? html`<div class="lab-zones">${zones.map(zoneChip)}</div>` : html`<div class="lab-empty">${T('maps.noZones')}</div>`}
        </div>
        <div class="lab-count">${mons ? html`<a href="#/monsters?floor=${encodeURIComponent(k)}">${monCount(mons)}</a>` : html`<span class="muted">${T('maps.mon0')}</span>`}<div class="lab-bar" aria-hidden="true"><i style="width:${(mons / maxMon * 100).toFixed(1)}%"></i></div></div>
      </div>`);
    });
    const legend = [['', 'maps.legend.zone'], ['rift', 'maps.legend.rift'], ['hidden-field', 'maps.legend.hidden']].concat(ug ? [['island', 'maps.legend.island']] : []);
    return html`<div class="lab reveal">${rows}<div class="lab-legend">${legend.map((x) => html`<span class="zchip ${x[0]}"><span class="k"></span>${T(x[1])}</span>`)}</div></div>
      <p class="lab-foot">${T('maps.top')}</p>`;
  }
  function locationTree() {
    if (!D.locations.length) return html`<p class="notice">${T('maps.noLoc')}</p>`;
    const openDepth = D.locations.length <= 80 ? 99 : 1;
    const seen = new Set();
    const node = (l, depth) => {
      if (seen.has(l.id)) return '';
      seen.add(l.id);
      const kids = sortLocs(R.children.get(l.id) || []);
      const mc = monstersAt(l).length;
      const row = html`${entLink('locations', l)}${l.kind ? html` <span class="badge dim">${enumLabel(l.kind)}</span>` : ''}${mc ? html` <span class="cnt">${monCount(mc)}</span>` : ''}`;
      if (!kids.length) return html`<li><span class="tnode"><span class="tleaf" aria-hidden="true"></span>${row}</span></li>`;
      return html`<li><details${depth < openDepth ? raw(' open') : ''}><summary><span class="tnode">${icon('chevR', 'twisty')}${row}</span></summary><ul>${kids.map((c) => node(c, depth + 1))}</ul></details></li>`;
    };
    return html`<ul class="tree">${sortLocs(R.roots).map((r) => node(r, 0))}</ul>`;
  }
  function viewMaps() {
    const labRoot = D.locations.find((l) => !R.parentOf.get(l.id) && /labyrinth/i.test(l.name || '') && (R.children.get(l.id) || []).some((c) => isFloorKind(c.kind)))
      || D.locations.find((l) => /^dungeon$/i.test(l.kind || '') && /labyrinth/i.test(l.name || ''));
    return {
      title: T('maps.title'), nav: 'maps',
      html: html`
        <div class="page-head"><h1>${T('maps.title')}</h1><p class="lede">${T('maps.lede')}</p></div>
        <div class="maps-grid">
          <section aria-labelledby="lab-h"><h2 id="lab-h">${labRoot ? entLink('locations', labRoot) : T('maps.lab')}</h2>${labyrinthDiagram()}</section>
          <section aria-labelledby="tree-h"><h2 id="tree-h">${T('maps.tree')} <a class="h-link" href="#/locations">${T('maps.table')}</a></h2>
            ${D.locations.length ? html`<div class="tree-tools"><button type="button" class="btn" data-act="tree-open">${T('maps.expand')}</button><button type="button" class="btn" data-act="tree-close">${T('maps.collapse')}</button></div>` : ''}
            ${locationTree()}</section>
        </div>`,
      mount(root) {
        root.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-act^="tree-"]');
          if (b) $$('.tree details', root).forEach((d) => { d.open = b.getAttribute('data-act') === 'tree-open'; });
        });
      },
    };
  }

  /* ---------- story: arcs ---------- */
  function jumpForm(n) {
    return html`<form class="jump" data-jump><label for="jump-n">${T('ch.jump')}</label><input id="jump-n" type="number" inputmode="numeric" min="1" max="${D.meta.chapters_total}" value="${n || ''}" required><button class="btn" type="submit">${T('ch.go')}</button></form>`;
  }
  function ribbon() {
    const total = D.meta.chapters_total;
    const segs = D.arcs.filter((a) => a.range).map((a, i) => {
      const left = ((a.range[0] - 1) / total) * 100, width = ((a.range[1] - a.range[0] + 1) / total) * 100;
      return html`<a class="rib-seg s${i % 2}" href="#/arc/${encodeURIComponent(a.id)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${arcLabel(a)} (${rangeText(a.range)})">${width > 2.2 ? (a.n == null ? '' : a.n) : ''}</a>`;
    });
    return html`<div class="ribbon" role="img" aria-label="${T('story.ribbon', { total })}">${segs}</div>
      <div class="rib-scale"><span>1</span><span>${Math.round(total / 4)}</span><span>${Math.round(total / 2)}</span><span>${Math.round((total * 3) / 4)}</span><span>${total}</span></div>`;
  }
  function chapterItems(list) {
    return html`<ol class="chlist">${list.map((c) => {
      const main = lang === 'th' && c.title_th ? c.title_th : c.title || T('ch.title', { n: c.n });
      const alt = lang === 'th' ? (c.title_th ? c.title : '') : c.title_th || '';
      return html`<li><a href="#/chapter/${c.n}"><span class="n">${c.n}</span><span class="tt">${main}${alt ? html`<small class="alt">${alt}</small>` : ''}</span>${hasText(c.tldr) ? html`<span class="tl">${tx(c.tldr, true)}</span>` : ''}</a></li>`;
    })}</ol>`;
  }
  function arcLen(a) {
    if (!a.range) return 0;
    let n = a.range[1] - a.range[0] + 1;
    for (const x of D.meta.chapters_missing) if (x >= a.range[0] && x <= a.range[1]) n--;
    return n;
  }
  function viewStory() {
    const total = D.meta.chapters_total;
    const inArc = new Set();
    D.arcs.forEach((a) => chaptersOfArc(a).forEach((c) => inArc.add(c.n)));
    const orphans = D.chapters.filter((c) => !inArc.has(c.n));
    return {
      title: T('story.title'), nav: 'story',
      html: html`
        <div class="page-head"><h1>${T('story.title')}</h1><p class="lede">${T('story.lede')}</p></div>
        ${D.arcs.length ? html`<div class="ribbon-wrap">${ribbon()}</div>` : ''}
        <div class="ch-bar">${jumpForm('')}<span class="muted small">${T('story.coverage', { have: fmtNum(D.chapters.length), total: fmtNum(total - D.meta.chapters_missing.length) })}</span></div>
        ${D.arcs.length ? (() => {
          const card = (a) => {
          const have = chaptersOfArc(a).length, len = arcLen(a);
          const p = headNames(a);
          return html`<a class="arc-card" href="#/arc/${encodeURIComponent(a.id)}">
            <div class="arc-top"><span class="arc-n">${T('arc.n', { n: a.n == null ? '?' : a.n })}</span><span>${rangeText(a.range)}</span></div>
            <h2>${p.main}${p.alt ? html`<small class="alt">${p.alt}</small>` : ''}</h2>
            ${hasText(a.synopsis) ? html`<p class="arc-syn">${tx(a.synopsis, true)}</p>` : ''}
            <div class="arc-meta">${len ? T('arc.coverage', { have: fmtNum(have), total: fmtNum(len) }) : ''}</div>
            ${len ? html`<div class="progress" aria-hidden="true"><i style="width:${Math.min(100, (have / len) * 100).toFixed(1)}%"></i></div>` : ''}
          </a>`;
          };
          const groups = [];
          D.arcs.forEach((a) => { const k = a.part ? t(a.part) : ''; if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, part: a.part, list: [] }); groups[groups.length - 1].list.push(a); });
          return groups.map((g) => html`${g.k ? html`<h2 class="part-head">${tx(g.part)}</h2>` : ''}<div class="arcs">${g.list.map(card)}</div>`);
        })() : html`<p class="notice">${T('story.noArcs')}</p>`}
        ${orphans.length ? html`<section class="subarc"><h3>${T('story.orphans')}</h3>${chapterItems(orphans)}</section>` : ''}`,
    };
  }
  function viewArc(id) {
    const a = ARC_BY_ID.get(id);
    if (!a) return { title: T('nf.title'), nav: 'story', html: html`${crumbs([[T('nav.story'), '#/story'], [id]])}<div class="page-head"><h1>${T('nf.title')}</h1><p class="lede">${T('arc.notFound', { id })}</p></div>` };
    const chs = chaptersOfArc(a);
    const used = new Set();
    const groups = a.subarcs.map((s) => {
      const list = s.range ? chs.filter((c) => c.n >= s.range[0] && c.n <= s.range[1]) : [];
      list.forEach((c) => used.add(c.n));
      return { s, list };
    });
    const rest = chs.filter((c) => !used.has(c.n));
    const p = headNames(a);
    const subRows = groups.map(({ s, list }) => {
      const nm = lang === 'th' && s.title_th ? s.title_th : s.title || '';
      return [list.length ? html`<a href="#/chapter/${list[0].n}">${nm}</a>` : nm, lang === 'th' ? (s.title_th ? s.title || '' : '') : s.title_th || '', rangeText(s.range), list.length ? fmtNum(list.length) : html`<span class="muted">0</span>`];
    });
    return {
      title: arcLabel(a), nav: 'story',
      html: html`
        ${crumbs([[T('nav.story'), '#/story'], [T('arc.n', { n: a.n == null ? '?' : a.n })]])}
        <header class="page-head ch-head"><h1>${T('arc.n', { n: a.n == null ? '?' : a.n })}: ${p.main}</h1>${p.alt ? html`<p class="alt-title">${p.alt}</p>` : ''}</header>
        <div class="badges">${a.range ? badge(rangeText(a.range)) : ''}${a.range ? badge(T('arc.coverage', { have: fmtNum(chs.length), total: fmtNum(arcLen(a)) }), 'dim') : ''}</div>
        ${hasText(a.synopsis) ? html`<div class="sec">${block(a.synopsis)}</div>` : ''}
        ${section('subarcs', T('arc.subarcs'), miniTable([{ label: T('arc.colTitle') }, { label: lang === 'th' ? 'English' : T('arc.colTh') }, { label: T('arc.colRange'), cls: 'nowrap' }, { label: T('arc.colHave'), cls: 'num' }], subRows))}
        <section class="sec" id="s-chapters"><h2>${T('arc.chapters')}</h2>
          ${chs.length ? '' : html`<p class="muted">${T('arc.noChapters')}</p>`}
          ${groups.filter((g) => g.list.length).map(({ s, list }) => html`<div class="subarc"><h3>${lang === 'th' && s.title_th ? s.title_th : s.title || ''}${s.range ? html`<span class="rng">${rangeText(s.range)}</span>` : ''}</h3>${chapterItems(list)}</div>`)}
          ${rest.length ? html`<div class="subarc"><h3>${T('arc.other')}</h3>${chapterItems(rest)}</div>` : ''}
        </section>`,
    };
  }

  /* ---------- chapter page: #/chapter/N ---------- */
  let PLACE_RE = null, PLACE_MAP = null;
  /** Escape a setting string and link every known location name inside it (longest names first).
   *  Only real names (EN/TH) are used: aliases are often generic words ("Maze") and would mislink. */
  function linkPlaces(text) {
    if (!PLACE_RE) {
      PLACE_MAP = new Map();
      const names = [];
      for (const l of D.locations) for (const nm of [l.name, l.name_th]) {
        if (nm && String(nm).trim().length >= 4) { const k = String(nm).toLowerCase(); if (!PLACE_MAP.has(k)) { PLACE_MAP.set(k, l); names.push(String(nm)); } }
      }
      names.sort((a, b) => b.length - a.length);
      PLACE_RE = names.length ? new RegExp(names.map(escRe).join('|'), 'gi') : false;
    }
    if (!PLACE_RE) return esc(text);
    let out = '', last = 0, m;
    PLACE_RE.lastIndex = 0;
    while ((m = PLACE_RE.exec(text))) {
      const before = text.charAt(m.index - 1), after = text.charAt(m.index + m[0].length);
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;   // whole words only
      const l = PLACE_MAP.get(m[0].toLowerCase());
      out += esc(text.slice(last, m.index)) + '<a href="' + esc(href('locations', l.id)) + '">' + esc(m[0]) + '</a>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  function inThisChapter(n) {
    const idx = chapterIndex().get(n);
    if (!idx) return '';
    const rows = CATS.filter((c) => idx[c] && idx[c].length).map((c) => html`<dt>${T('cat.' + c)}</dt><dd class="linklist">${capList(idx[c].slice().sort((a, b) => collator.compare(plainName(a), plainName(b))).map((e) => entLink(c, e, true)), 24, '')}</dd>`);
    return section('inch', T('ch.inThis'), html`<dl class="inch">${rows}</dl>`);
  }
  function chNavBtn(n, dir) {
    const lbl = dir < 0 ? T('ch.prev') : T('ch.next');
    if (n == null) return html`<button type="button" class="btn" disabled>${dir < 0 ? icon('chevL') : ''}<span class="lbl">${lbl}</span>${dir > 0 ? icon('chevR') : ''}</button>`;
    return html`<a class="btn" href="#/chapter/${n}" ${raw(dir < 0 ? 'data-ch-prev rel="prev"' : 'data-ch-next rel="next"')} title="${lbl}">${dir < 0 ? icon('chevL') : ''}<span class="lbl">${lbl}</span> <span>${T('ch.short', { n })}</span>${dir > 0 ? icon('chevR') : ''}</a>`;
  }
  function viewChapter(rawN) {
    const total = D.meta.chapters_total;
    const n = toInt(rawN);
    if (n == null || n < 1 || n > total) {
      return { title: T('nf.title'), nav: 'story', html: html`${crumbs([[T('nav.story'), '#/story'], [String(rawN)]])}<div class="page-head"><h1>${T('nf.title')}</h1><p class="lede">${T('ch.outOfRange', { n: rawN, total })}</p></div><div class="ch-bar">${jumpForm('')}</div>` };
    }
    const c = CH_BY_N.get(n);
    const missingSrc = D.meta.chapters_missing.indexOf(n) >= 0;
    const partialSrc = D.meta.chapters_partial.find((x) => x.n === n);
    const arc = arcOfChapter(n);
    const sub = subarcOf(arc, n);
    const prevN = neighbor(n, -1), nextN = neighbor(n, 1);
    const main = c ? (lang === 'th' && c.title_th ? c.title_th : c.title || '') : '';
    const alt = c ? (lang === 'th' ? (c.title_th ? c.title || '' : '') : c.title_th || '') : '';
    const chars = c ? arr(c.chars) : [];
    const setting = c ? t(c.setting) : '';
    const bar = html`<div class="ch-bar">${chNavBtn(prevN, -1)}<span class="spacer"></span>${jumpForm(n)}<span class="spacer"></span>${chNavBtn(nextN, 1)}</div>`;
    return {
      title: T('ch.title', { n }) + (main ? ': ' + main : ''), nav: 'story',
      html: html`
        <div class="reading">
        ${crumbs([[T('nav.story'), '#/story']].concat(arc ? [[T('arc.n', { n: arc.n == null ? '?' : arc.n }), '#/arc/' + encodeURIComponent(arc.id)]] : [], [[T('ch.short', { n })]]))}
        <header class="page-head ch-head"><h1>${T('ch.title', { n })}${main ? ': ' + main : ''}</h1>${alt ? html`<p class="alt-title" lang="${lang === 'th' ? 'en' : 'th'}">${alt}</p>` : ''}</header>
        ${bar}
        ${missingSrc ? html`<p class="notice">${T('ch.missingSrc', { n })}</p>` : !c ? html`<p class="notice">${T('ch.notInDb', { n })}</p>` : ''}
        ${partialSrc && c ? html`<p class="notice">${T('ch.partialSrc', { n, have: partialSrc.have != null ? fmtNum(partialSrc.have) : '?', total: partialSrc.total != null ? fmtNum(partialSrc.total) : '?' })}</p>` : ''}
        ${c ? html`<dl class="inch ch-meta">
            ${arc ? html`<dt>${T('ch.arc')}</dt><dd><a href="#/arc/${encodeURIComponent(arc.id)}">${arcLabel(arc)}</a>${sub ? html` <span class="muted">› ${lang === 'th' && sub.title_th ? sub.title_th : sub.title || ''}</span>` : ''}</dd>` : ''}
            ${setting ? html`<dt>${T('ch.setting')}</dt><dd>${raw(linkPlaces(setting))}</dd>` : ''}
            ${chars.length ? html`<dt>${T('ch.chars')}</dt><dd class="linklist">${capList(chars.map((x) => refHtml(x, ['characters'])), 16, '')}</dd>` : ''}
          </dl>
          ${hasText(c.tldr) ? html`<section class="tldr"><h2>${T('ch.tldr')}</h2><p>${tx(c.tldr)}</p></section>` : ''}` : ''}
        ${!missingSrc && (c || arc) ? html`<section class="sec" id="s-scenes"><h2>${T('ch.scenes')}</h2>${lang !== 'th' ? html`<p class="story-note">${T('ch.thaiNote')}</p>` : ''}<div class="story md" lang="th" data-story><p class="loading">${T('ch.loading')}</p></div></section>` : ''}
        ${inThisChapter(n)}
        <div class="ch-foot">${chNavBtn(prevN, -1)}${chNavBtn(nextN, 1)}</div>
        <p class="muted small" style="margin-top:12px">${T('ch.keys')}</p>
        </div>`,
      mount(root, seq) {
        const box = $('[data-story]', root);
        if (!box) return;
        if (!arc) { box.innerHTML = toHtml(html`<p class="muted">${T('ch.noStory')}</p>`); return; }
        loadStory(arc.id).then((story) => {
          if (seq !== renderSeq) return;                       // the user has navigated away
          const text = story[String(n)] != null ? story[String(n)] : story[n];
          box.innerHTML = text && String(text).trim() ? md(text) : toHtml(html`<p class="muted">${T('ch.noStory')}</p>`);
        }).catch(() => {
          if (seq !== renderSeq) return;
          box.innerHTML = toHtml(html`<p class="notice bad">${T('ch.fileMissing', { file: 'data/story/' + arc.id + '.js' })}</p>`);
        });
      },
    };
  }

  /* =================================================================
   * 9. Search — one in-memory index over names, Thai names, aliases and
   *    ids of every category, plus chapter titles and chapter numbers.
   * ================================================================= */
  let SIDX = null;
  function buildSearchIndex() {
    SIDX = [];
    for (const cat of CATS) for (const e of D[cat]) {
      const keys = [];
      const push = (s) => { const k = norm(s); if (k && keys.indexOf(k) < 0) keys.push(k); };
      push(e.name); push(e.name_th); push(e.title); push(e.title_th);
      arr(e.aliases).forEach(push);
      if (e.number) push(e.number);
      push(String(e.id).replace(/[-_]+/g, ' '));
      const imp = toInt(e.importance);
      SIDX.push({ cat, e, keys, boost: cat === 'characters' ? (imp === 1 ? 6 : imp === 2 ? 3 : 0) : 0 });
    }
    for (const c of D.chapters) {
      const keys = [];
      [c.title, c.title_th].forEach((s) => { const k = norm(s); if (k) keys.push(k); });
      SIDX.push({ cat: 'chapters', e: c, keys, boost: 0 });
    }
  }
  function scoreKeys(keys, q, toks) {
    let best = 0;
    for (const k of keys) {
      let s = 0;
      if (k === q) s = 100;
      else if (k.startsWith(q)) s = 80 - Math.min(12, (k.length - q.length) / 3);
      else if (k.indexOf(' ' + q) >= 0 || k.indexOf('(' + q) >= 0) s = 62;
      else if (k.indexOf(q) >= 0) s = 45;
      else if (toks.length > 1 && toks.every((tk) => k.indexOf(tk) >= 0)) s = 30;
      if (s > best) best = s;
    }
    return best;
  }
  const SEARCH_ORDER = CATS.concat(['chapters']);
  /** Grouped results: {groups: [{cat, total, items}], flat: [...all shown items in order], total}. */
  function runSearch(q, cat, perCat) {
    if (!SIDX) buildSearchIndex();
    const nq = norm(q);
    const res = { groups: [], flat: [], total: 0 };
    if (!nq) return res;
    const toks = nq.split(' ').filter(Boolean);
    const m = nq.match(/^(?:ch(?:apter)?\.?\s*|บท(?:ที่)?\s*|#)?(\d{1,4})$/);
    const num = m ? toInt(m[1]) : null;
    const groups = new Map();
    const put = (c, x) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(x); };
    for (const it of SIDX) {
      if (cat !== 'all' && it.cat !== cat) continue;
      let s = scoreKeys(it.keys, nq, toks);
      if (it.cat === 'chapters' && num != null && it.e.n === num) s = 120;
      if (s) put(it.cat, { cat: it.cat, e: it.e, s: s + it.boost });
    }
    // a valid chapter number that has no metadata yet still gets a hit
    if (num != null && (cat === 'all' || cat === 'chapters') && num >= 1 && num <= D.meta.chapters_total && !CH_BY_N.has(num)) {
      put('chapters', { cat: 'chapters', e: { n: num, title: '' }, s: 110, pseudo: true });
    }
    for (const [c, list] of groups) {
      list.sort((a, b) => b.s - a.s || (c === 'chapters' ? a.e.n - b.e.n : collator.compare(plainName(a.e), plainName(b.e))));
      res.groups.push({ cat: c, total: list.length, best: list[0].s, items: list.slice(0, perCat) });
      res.total += list.length;
    }
    res.groups.sort((a, b) => b.best - a.best || SEARCH_ORDER.indexOf(a.cat) - SEARCH_ORDER.indexOf(b.cat));
    res.groups.forEach((g) => g.items.forEach((x) => res.flat.push(x)));
    return res;
  }
  const hitHref = (x) => (x.cat === 'chapters' ? '#/chapter/' + x.e.n : href(x.cat, x.e.id));
  function hitName(x) {
    if (x.cat !== 'chapters') return nameHtml(x.e);
    const tt = chTitle(x.e);
    return html`${T('ch.title', { n: x.e.n })}${tt ? ': ' + tt : ''}`;
  }
  const hitLink = (x) => html`<a href="${hitHref(x)}">${hitName(x)}</a>`;
  /** One-line description shown next to a hit. */
  function describe(cat, e) {
    switch (cat) {
      case 'monsters': return html`${gradeBadge(e.grade)} ${enumLabel(e.category)}`;
      case 'essences': return html`${gradeBadge(e.grade)} ${arr(e.colors).map((c) => swatch(c))}`;
      case 'characters': { const r = e.race ? resolveE(e.race, 'races') : null; return joinHtml([r ? plainName(r) : prettyId(e.race || ''), arr(e.roles).length ? t(arr(e.roles)[0]) : '']); }
      case 'skills': return joinHtml([enumLabel(e.kind), sourceName(e.source)]);
      case 'items': return joinHtml([e.number || '', enumLabel(e.category)]);
      case 'locations': { const f = locFloor(e); return joinHtml([enumLabel(e.kind), f ? floorLabel(f) : '']); }
      case 'factions': return enumLabel(e.kind);
      case 'lore': return enumLabel(e.topic);
      case 'chapters': { if (!CH_BY_N.has(e.n)) return T('search.noChapter'); const a = arcOfChapter(e.n); return a ? T('arc.n', { n: a.n == null ? '?' : a.n }) : ''; }
      default: return '';
    }
  }
  const searchCats = () => [['all', T('search.all')]].concat(CATS.map((c) => [c, T('cat.' + c)]), [['chapters', T('cat.chapters')]]);
  const searchHash = (q, cat) => '#/search?q=' + encodeURIComponent(q) + (cat && cat !== 'all' ? '&cat=' + encodeURIComponent(cat) : '');
  function submitSearch(q, cat) { q = String(q || '').trim(); if (q) go(searchHash(q, cat)); }

  /** Live dropdown under a search input (header and home page).
   *  ↑/↓ move, Enter opens the highlighted (first) hit, Esc closes. */
  function attachSearchBox(input, getCat, pop) {
    let hits = [], active = -1;
    const close = () => { pop.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    function highlight() {
      $$('.sbox-item', pop).forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === active));
        if (i === active) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      });
    }
    function paint() {
      const q = input.value.trim();
      if (!q) { hits = []; close(); return; }
      const cat = getCat ? getCat() : 'all';
      const res = runSearch(q, cat, cat === 'all' ? 5 : 12);
      hits = res.flat;
      active = hits.length ? 0 : -1;
      let i = 0;
      pop.innerHTML = toHtml(html`${res.groups.map((g) => html`<div class="sbox-group" role="group" aria-label="${T('cat.' + g.cat)}"><h3><span>${T('cat.' + g.cat)}</span><span>${g.total > g.items.length ? fmtNum(g.total) : ''}</span></h3>
          ${g.items.map((x) => html`<a class="sbox-item" role="option" id="${pop.id}-${i++}" href="${hitHref(x)}" aria-selected="false"><span class="nm">${hitName(x)}</span><span class="ds">${describe(x.cat, x.e)}</span></a>`)}</div>`)}
        ${hits.length ? '' : html`<div class="sbox-empty">${T('search.none', { q })}</div>`}
        <a class="sbox-foot" href="${searchHash(q, cat)}">${T('search.seeAll', { q })}</a>`);
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight();
    }
    const later = debounce(paint, 70);
    input.addEventListener('input', later);
    input.addEventListener('focus', () => { if (input.value.trim()) paint(); });
    input.addEventListener('blur', () => setTimeout(close, 160));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (pop.hidden) paint();
        if (hits.length) { active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; highlight(); }
        ev.preventDefault();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        paint();                                         // results may be one keystroke behind
        const hit = hits[active >= 0 ? active : 0];
        close();
        input.blur();
        go(hit ? hitHref(hit) : searchHash(q, getCat ? getCat() : 'all'));
      } else if (ev.key === 'Escape') { close(); input.blur(); }
    });
    pop.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep focus so the click lands
    pop.addEventListener('click', (ev) => { if (ev.target.closest('a')) { close(); input.blur(); } });
    return { refresh: () => { if (document.activeElement === input && input.value.trim()) paint(); } };
  }

  function searchResults(q, cat) {
    if (!q) return html`<p class="muted">${T('search.prompt')}</p>`;
    const per = cat === 'all' ? 50 : 500;
    const res = runSearch(q, cat, per);
    const counts = runSearch(q, 'all', 1);
    const tabs = [['all', counts.total]].concat(counts.groups.map((g) => [g.cat, g.total]).sort((a, b) => SEARCH_ORDER.indexOf(a[0]) - SEARCH_ORDER.indexOf(b[0])));
    return html`
      <p class="muted">${res.total === 1 ? T('search.results1', { q }) : T('search.results', { n: fmtNum(res.total), q })}</p>
      ${counts.total ? html`<nav class="sr-tabs" aria-label="${T('search.cat')}">${tabs.map(([c, n]) => html`<a href="${searchHash(q, c)}" aria-current="${String(c === cat)}">${c === 'all' ? T('search.all') : T('cat.' + c)} <span class="n">${fmtNum(n)}</span></a>`)}</nav>` : ''}
      ${res.groups.map((g) => html`<section class="sr-group"><h2>${T('cat.' + g.cat)} <span class="muted small">${fmtNum(g.total)}</span>${g.cat !== 'chapters' ? html` <a href="#/${g.cat}?q=${encodeURIComponent(q)}">${T('search.inList')}</a>` : ''}</h2>
        <ul class="sr-list">${g.items.map((x) => html`<li>${hitLink(x)}<span class="ds">${describe(x.cat, x.e)}</span></li>`)}</ul>
        ${g.total > g.items.length ? html`<p class="muted small">${T('search.capped', { n: fmtNum(g.items.length) })}</p>` : ''}</section>`)}`;
  }
  function viewSearch(params) {
    const q = (params.get('q') || '').trim();
    let cat = params.get('cat') || 'all';
    if (cat !== 'all' && SEARCH_ORDER.indexOf(cat) < 0) cat = 'all';
    return {
      title: q ? T('search.title') + ': ' + q : T('search.title'), nav: '',
      html: html`
        <div class="page-head"><h1>${T('search.title')}</h1></div>
        <form class="filters sr-form" data-search-form role="search" autocomplete="off">
          <label class="field grow"><span>${T('search.label')}</span><input type="search" name="q" value="${q}" placeholder="${T('search.placeholder')}" spellcheck="false"></label>
          <label class="field"><span>${T('search.cat')}</span><select name="cat">${searchCats().map(([v, l]) => html`<option value="${v}"${v === cat ? raw(' selected') : ''}>${l}</option>`)}</select></label>
        </form>
        <div data-results>${searchResults(q, cat)}</div>`,
      mount(root) {
        const form = $('[data-search-form]', root), out = $('[data-results]', root);
        const update = () => {
          const q2 = form.elements.q.value.trim(), c2 = form.elements.cat.value;
          out.innerHTML = toHtml(searchResults(q2, c2));
          replaceHash(q2 ? searchHash(q2, c2) : '#/search');
        };
        form.addEventListener('input', debounce(update, 160));
        form.addEventListener('change', update);
        form.addEventListener('submit', (ev) => {
          ev.preventDefault(); update();
          const first = $('.sr-list a', out);
          if (first) go(first.getAttribute('href'));
        });
        if (!q) form.elements.q.focus({ preventScroll: true });
      },
    };
  }

  /* ---------- #/check : data report for the data team ---------- */
  const REF_FIELDS = [
    ['races', 'homeland', ['locations']], ['races', 'notable', ['characters']], ['races', 'abilities[].examples[].who', ['characters']],
    ['characters', 'race', ['races']], ['characters', 'affiliations', ['factions']], ['characters', 'essences[].essence', ['essences']],
    ['characters', 'skills', ['skills']], ['characters', 'items', ['items']], ['characters', 'relationships[].who', ['characters']],
    ['monsters', 'zones', ['locations']], ['monsters', 'essence', ['essences']],
    ['essences', 'monster', ['monsters']], ['essences', 'users[].who', ['characters']],
    ['skills', 'source.id', null], ['skills', 'users', ['characters']], ['items', 'owners[].who', ['characters']],
    ['locations', 'parent', ['locations']], ['locations', 'monsters', ['monsters']],
    ['factions', 'leader', ['characters']], ['factions', 'members', ['characters']],
  ];
  function pathValues(e, path) {
    let cur = [e];
    for (const seg of path.split('.')) {
      const key = seg.endsWith('[]') ? seg.slice(0, -2) : seg;
      const next = [];
      for (const x of cur) {
        if (x == null) continue;
        const v = typeof x === 'object' ? x[key] : (key === 'essence' || key === 'who' ? x : undefined);   // tolerate plain strings in object lists
        arr(v).forEach((y) => next.push(y));                 // arrays are always flattened ("[]" just documents it)
      }
      cur = next;
    }
    return cur.filter((v) => v != null && v !== '' && typeof v !== 'object');
  }
  function viewCheck() {
    const unres = [], free = [];
    for (const [cat, path, cats] of REF_FIELDS) for (const e of D[cat]) {
      const vals = pathValues(e, path);
      for (const v of vals) {
        const c = path === 'source.id' ? sourceCats(e.source && e.source.type) : cats;
        if (resolve(v, c)) continue;
        (ID_LIKE.test(String(v)) ? unres : free).push([T('cat.' + cat), e, cat, path, String(v)]);
      }
    }
    const missingMeta = [];
    for (let n = 1; n <= D.meta.chapters_total; n++) if (!CH_BY_N.has(n) && D.meta.chapters_missing.indexOf(n) < 0) missingMeta.push(n);
    const ranges = [];
    missingMeta.forEach((n) => { const r = ranges[ranges.length - 1]; if (r && n === r[1] + 1) r[1] = n; else ranges.push([n, n]); });
    const badArc = D.chapters.filter((c) => c.arc != null && c.arc !== '' && !ARC_BY_ID.has(String(c.arc)));
    const LIMIT = 300;
    const refTable = (rows) => html`${miniTable([{ label: T('check.entry') }, { label: T('check.field') }, { label: T('check.value') }],
      rows.slice(0, LIMIT).map((r) => [html`<span class="muted">${r[0]}:</span> ${entLink(r[2], r[1], true)}`, html`<code>${r[3]}</code>`, r[4]]))}${rows.length > LIMIT ? html`<p class="muted small">${T('check.andMore', { n: fmtNum(rows.length - LIMIT) })}</p>` : ''}`;
    const ok = html`<p class="check-ok">${T('check.ok')}</p>`;
    return {
      title: T('check.title'), nav: '',
      html: html`
        <div class="page-head"><h1>${T('check.title')}</h1><p class="lede">${T('check.lede')}</p></div>
        ${section('counts', T('check.counts'), html`<div class="check-grid">${CATS.concat(['arcs', 'chapters']).map((c) => html`<div class="panel"><b>${fmtNum((D[c] || []).length)}</b>${T('cat.' + c)}</div>`)}</div>`)}
        <section class="sec"><h2>${T('check.dupes')}</h2>${ISSUES.dupes.length ? miniTable([{ label: T('check.entry') }, { label: T('lbl.id') }], ISSUES.dupes.map((d) => [T('cat.' + d.cat), html`<code>${d.id}</code>`])) : ok}</section>
        <section class="sec"><h2>${T('check.noId')}</h2>${ISSUES.noId.length ? miniTable([{ label: T('check.entry') }, { label: T('check.value') }], ISSUES.noId.slice(0, LIMIT).map((d) => [T('cat.' + d.cat), html`<code>${JSON.stringify(d.e).slice(0, 140)}</code>`])) : ok}</section>
        <section class="sec"><h2>${T('check.unres')} <span class="muted small">${fmtNum(unres.length)}</span></h2><p class="muted small">${T('check.unresNote')}</p>${unres.length ? refTable(unres) : ok}</section>
        <section class="sec"><h2>${T('check.free')} <span class="muted small">${fmtNum(free.length)}</span></h2><p class="muted small">${T('check.freeNote')}</p>${free.length ? refTable(free) : ok}</section>
        <section class="sec"><h2>${T('check.chapters')}</h2>
          <h3>${T('check.noMeta')} <span class="muted small">${fmtNum(missingMeta.length)}</span></h3>
          <p>${ranges.length ? ranges.map((r) => (r[0] === r[1] ? r[0] : r[0] + '–' + r[1])).join(', ') : T('check.ok')}</p>
          <h3>${T('check.badArc')}</h3>${badArc.length ? html`<p>${badArc.map((c) => html`${chChip(c.n)} <code>${c.arc}</code> `)}</p>` : ok}
        </section>
        <section class="sec"><h2>${T('check.story')}</h2><p><button type="button" class="btn" data-act="check-story">${T('check.storyBtn')}</button></p><ul class="plain" data-story-report></ul></section>`,
      mount(root) {
        root.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-act="check-story"]');
          if (!b) return;
          b.disabled = true;
          const out = $('[data-story-report]', root);
          out.innerHTML = '';
          D.arcs.reduce((p, a) => p.then(() => loadStory(a.id).then((story) => {
            const have = Object.keys(story).length;
            const gaps = chaptersOfArc(a).filter((c) => !(story[String(c.n)] && String(story[String(c.n)]).trim())).map((c) => c.n);
            out.insertAdjacentHTML('beforeend', toHtml(html`<li>${T('check.storyOk', { arc: a.id, n: fmtNum(have) })}${gaps.length ? html`<br><span class="muted">${T('check.storyGaps', { arc: a.id, list: gaps.join(', ') })}</span>` : ''}</li>`));
          }, () => {
            out.insertAdjacentHTML('beforeend', toHtml(html`<li class="val-neg">${T('check.storyMissing', { arc: a.id })}</li>`));
          })), Promise.resolve()).then(() => { b.disabled = false; });
        });
      },
    };
  }

  function viewNotFound() {
    return {
      title: T('nf.title'), nav: '',
      html: html`<div class="page-head"><h1>${T('nf.title')}</h1><p class="lede">${T('nf.body', { h: location.hash })}</p></div><p><a class="btn" href="#/">${T('nf.home')}</a></p>`,
    };
  }

  /* =================================================================
   * 10. Chrome — sticky header (brand, global search, theme, language),
   *     category nav and footer. Re-rendered when the language changes.
   * ================================================================= */
  const TOP = document.getElementById('top');
  const VIEW = document.getElementById('view');
  const FOOT = document.getElementById('foot');
  const NAV = [['home', '#/'], ['story', '#/story'], ['races', '#/races'], ['characters', '#/characters'], ['monsters', '#/monsters'],
    ['essences', '#/essences'], ['skills', '#/skills'], ['items', '#/items'], ['maps', '#/maps'], ['factions', '#/factions'], ['lore', '#/lore']];
  const brandName = () => (D.meta && D.meta.title) || 'Barbarian Codex';
  const curTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  let headerSearch = null;

  function renderHeader() {
    const prevQ = $('#gs-q') ? $('#gs-q').value : '';
    const prevCat = $('#gs-cat') ? $('#gs-cat').value : 'all';
    const open = TOP.classList.contains('search-open');
    const th = curTheme();
    TOP.innerHTML = toHtml(html`<div class="wrap">
      <div class="top-row">
        <a class="brand" href="#/">${SIGIL}<span class="brand-name">${brandName()}</span></a>
        <div class="gsearch" role="search">
          <label class="sr" for="gs-cat">${T('search.cat')}</label>
          <select id="gs-cat">${searchCats().map(([v, l]) => html`<option value="${v}"${v === prevCat ? raw(' selected') : ''}>${l}</option>`)}</select>
          <label class="sr" for="gs-q">${T('search.label')}</label>
          <input id="gs-q" type="search" placeholder="${T('search.placeholder')}" value="${prevQ}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="gs-pop" aria-autocomplete="list">
          <span class="kbd" aria-hidden="true" title="${T('search.hintKey')}">/</span>
          <div class="sbox-pop" id="gs-pop" role="listbox" hidden></div>
        </div>
        <div class="top-tools">
          <button type="button" class="icon-btn" id="search-toggle" aria-label="${T('search.toggle')}" aria-expanded="${String(open)}">${icon('search')}</button>
          <button type="button" class="icon-btn" id="theme-btn" aria-label="${th === 'dark' ? T('theme.toLight') : T('theme.toDark')}" title="${th === 'dark' ? T('theme.toLight') : T('theme.toDark')}">${icon(th === 'dark' ? 'sun' : 'moon')}</button>
          <div class="lang">
            <button type="button" class="lang-pill" id="lang-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="lang-menu" aria-label="${T('lang.label', { l: T('lang.' + lang) })}">${flag(lang)}<span>${lang.toUpperCase()}</span>${icon('chevD', 'caret')}</button>
            <ul class="lang-menu" id="lang-menu" role="menu" hidden>
              ${[['th', 'TH'], ['en', 'EN']].map(([code, label]) => html`<li role="none"><button type="button" role="menuitemradio" aria-checked="${String(code === lang)}" data-lang="${code}" lang="${code}">${flag(code)}<span>${label}</span>${icon('check', 'check')}</button></li>`)}
            </ul>
          </div>
        </div>
      </div>
      <nav class="mainnav" aria-label="${T('nav.label')}">${NAV.map(([k, h]) => html`<a href="${h}" data-nav="${k}">${T('nav.' + k)}</a>`)}</nav>
    </div>`);
    const gq = $('#gs-q'), gc = $('#gs-cat');
    headerSearch = attachSearchBox(gq, () => gc.value, $('#gs-pop'));
    gc.addEventListener('change', () => { gq.focus(); headerSearch.refresh(); });
    $('#search-toggle').addEventListener('click', () => {
      const on = !TOP.classList.contains('search-open');
      TOP.classList.toggle('search-open', on);
      $('#search-toggle').setAttribute('aria-expanded', String(on));
      if (on) gq.focus();
    });
    $('#theme-btn').addEventListener('click', () => setTheme(curTheme() === 'dark' ? 'light' : 'dark'));
    const btn = $('#lang-btn'), menu = $('#lang-menu');
    btn.addEventListener('click', () => (menu.hidden ? openLangMenu() : closeLangMenu(false)));
    btn.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowDown') { ev.preventDefault(); openLangMenu(); } });
    menu.addEventListener('click', (ev) => { const b = ev.target.closest('[data-lang]'); if (b) { closeLangMenu(true); setLang(b.getAttribute('data-lang')); } });
    menu.addEventListener('keydown', (ev) => {
      const items = $$('[data-lang]', menu), i = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeLangMenu(true); }
      else if (ev.key === 'Tab') closeLangMenu(false);
    });
    setActiveNav(currentNav);
  }
  function openLangMenu() {
    const menu = $('#lang-menu'), btn = $('#lang-btn');
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const cur = $('[aria-checked="true"]', menu) || $('[data-lang]', menu);
    if (cur) cur.focus();
  }
  function closeLangMenu(refocus) {
    const menu = $('#lang-menu'), btn = $('#lang-btn');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }
  let currentNav = '';
  function setActiveNav(key) {
    currentNav = key || '';
    $$('.mainnav a', TOP).forEach((a) => { if (a.getAttribute('data-nav') === currentNav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const on = $('.mainnav a[aria-current]', TOP);
    if (on && on.scrollIntoView) { const nav = on.parentElement; nav.scrollLeft = Math.max(0, on.offsetLeft - nav.clientWidth / 2 + on.offsetWidth / 2); }
  }
  function renderFooter() {
    const m = D.meta || {};
    FOOT.innerHTML = toHtml(html`<div class="wrap"><span>${T('foot.about')}</span>
      <span>${m.version ? T('foot.data', { v: m.version }) : ''}${m.version && m.generated ? ', ' : ''}${m.generated ? T('foot.generated', { d: m.generated }) : ''}${m.version || m.generated ? ' — ' : ''}<a href="#/check">${T('foot.check')}</a></span></div>`);
  }
  function setTheme(th) {
    document.documentElement.setAttribute('data-theme', th);
    store.set('codex.theme', th);
    const b = $('#theme-btn');
    if (b) {
      b.innerHTML = toHtml(icon(th === 'dark' ? 'sun' : 'moon'));
      const label = th === 'dark' ? T('theme.toLight') : T('theme.toDark');
      b.setAttribute('aria-label', label); b.setAttribute('title', label);
    }
  }
  function setLang(l) {
    const next = l === 'th' ? 'th' : 'en';
    store.set('codex.lang', next);
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = lang;
    collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    const y = window.scrollY;
    renderHeader(); renderFooter(); render();
    window.scrollTo(0, y);
  }

  /* =================================================================
   * 11. Router + boot
   * ================================================================= */
  let renderSeq = 0;
  let curHash = location.hash;
  let navByClick = false;
  let ignoreHash = null;
  const scrollMem = new Map();

  function parseHash() {
    let h = location.hash.replace(/^#!?/, '');
    if (h.charAt(0) !== '/') h = '/' + h;
    const qi = h.indexOf('?');
    const path = (qi >= 0 ? h.slice(0, qi) : h).split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    return { path, params: new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '') };
  }
  function route() {
    const { path, params } = parseHash();
    const a = path[0], b = path[1];
    if (!a || a === 'home') return viewHome();
    if ((a === 'story' || a === 'arcs' || a === 'chapters') && !b) return viewStory();
    if (a === 'arc' && b) return viewArc(b);
    if (a === 'chapter' && b) return viewChapter(b);
    if (a === 'maps' || a === 'map') return viewMaps();
    if (a === 'search') return viewSearch(params);
    if (a === 'check') return viewCheck();
    if (CATS.indexOf(a) >= 0 && !b) return viewList(a, params);
    if (FROM_SINGULAR[a] && b) return viewDetail(FROM_SINGULAR[a], b);
    if (CATS.indexOf(a) >= 0 && b) return viewDetail(a, b);          // #/monsters/ogre also works
    return viewNotFound();
  }
  function render() {
    const seq = ++renderSeq;
    let v;
    try { v = route(); } catch (err) {
      console.error(err);
      v = { title: '', nav: '', html: html`<div class="page-head"><h1>${T('app.crash')}</h1></div><p class="notice bad"><code>${String(err && err.message || err)}</code></p>` };
    }
    document.title = (v.title ? v.title + ' — ' : '') + brandName();
    // Each render gets a fresh wrapper, so listeners added by mount() die with the page.
    VIEW.innerHTML = '<div class="page">' + toHtml(v.html) + '</div>';
    setActiveNav(v.nav);
    if (v.mount) { try { v.mount(VIEW.firstElementChild, seq); } catch (err) { console.error(err); } }
  }
  /** Navigate to a hash (scrolls to the top like a link click). */
  function go(h) {
    navByClick = true;
    if (location.hash === h) { onHashChange(); return; }
    location.hash = h;
  }
  /** Change the URL without a re-render or a history entry (list filters, search typing). */
  function replaceHash(h) {
    if (location.hash === h) return;
    curHash = h;
    try { history.replaceState(history.state, '', h); }
    catch (e) { ignoreHash = h; location.replace(h); }
  }
  function onHashChange() {
    if (ignoreHash !== null && location.hash === ignoreHash) { ignoreHash = null; curHash = location.hash; return; }
    scrollMem.set(curHash, window.scrollY);
    curHash = location.hash;
    closeLangMenu(false);
    TOP.classList.remove('search-open');
    render();
    window.scrollTo(0, navByClick ? 0 : scrollMem.get(curHash) || 0);
    navByClick = false;
    // Move focus to the new page for keyboard/screen-reader users, unless the user is typing somewhere.
    const ae = document.activeElement;
    if (!ae || !/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) VIEW.focus({ preventScroll: true });
  }
  function focusSearch() {
    if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
      TOP.classList.add('search-open');
      $('#search-toggle').setAttribute('aria-expanded', 'true');
    }
    const q = $('#gs-q');
    q.focus(); q.select();
  }

  function bindGlobal() {
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('click', (ev) => {
      const t0 = ev.target;
      if (!t0 || !t0.closest) return;
      const plain = ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
      const sc = t0.closest('[data-scroll]');
      if (sc && plain) {
        ev.preventDefault();
        const el = document.getElementById(sc.getAttribute('data-scroll'));
        if (el) { const d = el.querySelector('details.sec-fold'); if (d) d.open = true; el.scrollIntoView({ block: 'start' }); }
        return;
      }
      const a = t0.closest('a[href^="#"]');
      if (a && plain) {
        if (a.hasAttribute('data-skip')) { ev.preventDefault(); VIEW.focus(); return; }
        if (a.getAttribute('href') === location.hash) { ev.preventDefault(); window.scrollTo(0, 0); return; }
        navByClick = true;
        return;
      }
      const more = t0.closest('[data-act="more-refs"]');
      if (more) {
        const box = more.parentElement;
        const refs = (box.getAttribute('data-refs') || '').split(',').map(toInt).filter((n) => n != null);
        box.innerHTML = toHtml(refs.map(chChip));
        return;
      }
      const cm = t0.closest('[data-act="cap-more"]');
      if (cm) {
        const rest = cm.previousElementSibling;
        if (rest && rest.classList.contains('cap-rest')) {
          const open = rest.hidden;
          rest.hidden = !open;
          cm.textContent = cm.getAttribute(open ? 'data-less' : 'data-more');
          cm.setAttribute('aria-expanded', String(open));
        }
        return;
      }
      const tg = t0.closest('[data-act="tl-open"], [data-act="tl-close"]');
      if (tg) {
        const box = tg.closest('.tl-groups');
        if (box) $$('details.tl-arc', box).forEach((d) => { d.open = tg.getAttribute('data-act') === 'tl-open'; });
        return;
      }
      const tr = t0.closest('tr[data-href]');
      if (tr && plain && !t0.closest('a, button, input, select, label, summary')) {
        const sel = window.getSelection && String(window.getSelection());
        if (!sel) go(tr.getAttribute('data-href'));
        return;
      }
      if (!t0.closest('.lang')) closeLangMenu(false);
    });
    document.addEventListener('submit', (ev) => {
      const f = ev.target.closest && ev.target.closest('form[data-jump]');
      if (!f) return;
      ev.preventDefault();
      const n = toInt($('input', f).value);
      if (n != null) go('#/chapter/' + n);
    });
    document.addEventListener('keydown', (ev) => {
      const el = ev.target, tag = (el && el.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable);
      if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); focusSearch(); return; }
      if (ev.key === 'Escape') { closeLangMenu(false); return; }
      if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        if (el && el.closest && el.closest('.table-wrap, .lang, .mainnav')) return;
        const link = $(ev.key === 'ArrowLeft' ? '[data-ch-prev]' : '[data-ch-next]', VIEW);
        if (link) { ev.preventDefault(); go(link.getAttribute('href')); }
      }
    });
    // Follow the OS colour scheme until the user picks a theme.
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const follow = () => { if (!store.get('codex.theme')) { document.documentElement.setAttribute('data-theme', mq.matches ? 'light' : 'dark'); setThemeIconOnly(); } };
      if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
    } catch (e) { /* matchMedia unavailable */ }
  }
  function setThemeIconOnly() {
    const b = $('#theme-btn');
    if (!b) return;
    const th = curTheme();
    b.innerHTML = toHtml(icon(th === 'dark' ? 'sun' : 'moon'));
    b.setAttribute('aria-label', th === 'dark' ? T('theme.toLight') : T('theme.toDark'));
  }

  function boot() {
    lang = store.get('codex.lang') === 'th' ? 'th' : 'en';
    document.documentElement.lang = lang;
    collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    const skip = $('[data-skip]');
    if (skip) skip.textContent = T('skip');
    if (!HAS_DB) {
      D.meta = {};
      VIEW.innerHTML = toHtml(html`<div class="page-head"><h1>${T('app.loadFail.title')}</h1></div><p class="notice bad">${T('app.loadFail.body')}</p>`);
      return;
    }
    prepareData();
    renderHeader();
    renderFooter();
    bindGlobal();
    render();
  }

  // Small debugging/maintenance handle (not used by the page itself).
  window.Codex = { version: '1.0', t, T, md, resolve, data: D, reload: () => render() };

  boot();
})();
