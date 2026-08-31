export type PageMapNode = {
  nodeId: string;
  path: string;
  domPath: string;
  semanticPath: string;
  logicalPath: string;
  tag: string;
  kind: 'document' | 'container' | 'control' | 'content';
  domId?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  type?: string;
  href?: string;
  src?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  childCount: number;
  expandable: boolean;
  shadow: boolean;
  children?: PageMapNode[];
};

export type DomLocator = {
  nodeId?: unknown;
  path?: unknown;
  domPath?: unknown;
  semanticPath?: unknown;
  logicalPath?: unknown;
  selector?: unknown;
  role?: unknown;
  name?: unknown;
  label?: unknown;
  text?: unknown;
  tag?: unknown;
  exact?: unknown;
};

type DomRequest = DomLocator & {
  kind?: string;
  action?: string;
  format?: unknown;
  limit?: unknown;
  offset?: unknown;
  children?: unknown;
  nodes?: unknown;
  depth?: unknown;
  max?: unknown;
  all?: unknown;
  operation?: unknown;
  value?: unknown;
  text?: unknown;
  replace?: unknown;
  x?: unknown;
  y?: unknown;
  behavior?: unknown;
  block?: unknown;
};

const skipped = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta']);
const containers = new Set([
  'html', 'body', 'main', 'nav', 'header', 'footer', 'aside', 'section', 'article', 'form', 'fieldset',
  'dialog', 'details', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'menu', 'dl', 'figure', 'iframe',
]);
const controls = new Set(['button', 'input', 'select', 'textarea', 'a', 'summary', 'option']);
const content = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'legend', 'p', 'li', 'dt', 'dd', 'th', 'td', 'caption', 'figcaption']);
const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const pathLandmarks = new Set(['main', 'nav', 'aside', 'header', 'footer', 'dialog']);
const textLimit = 160;
const maximumNodes = 200;
const maximumDepth = 6;

export class DomFault extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new DomFault('RANGE', `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function compact(value: string, limit = textLimit): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function tag(element: Element): string {
  return element.localName.toLowerCase();
}

function included(element: Element): boolean {
  return !skipped.has(tag(element))
    && !element.hasAttribute('hidden')
    && element.getAttribute('aria-hidden') !== 'true'
    && !(tag(element) === 'input' && element.getAttribute('type')?.toLowerCase() === 'hidden');
}

function elementChildren(root: Document | Element | ShadowRoot): Element[] {
  const source = 'children' in root ? [...root.children] : [];
  return source.filter(included);
}

function directChildren(element: Element): Element[] {
  return [
    ...elementChildren(element),
    ...(element.shadowRoot ? elementChildren(element.shadowRoot) : []),
  ];
}

function segment(element: Element): string {
  const name = tag(element);
  const parent = element.parentElement;
  const root = element.getRootNode();
  const siblings = parent
    ? [...parent.children]
    : root && 'children' in root ? [...(root.children as HTMLCollectionOf<Element>)] : [element];
  const matches = siblings.filter((candidate) => tag(candidate) === name);
  return `${name}[${Math.max(1, matches.indexOf(element) + 1)}]`;
}

export function elementPath(element: Element): string {
  if (element.parentElement) return `${elementPath(element.parentElement)}/${segment(element)}`;
  const root = element.getRootNode() as ShadowRoot | Document;
  if (root.nodeType === 11 && 'host' in root && root.host) {
    return `${elementPath(root.host)}::shadow/${segment(element)}`;
  }
  return `/${segment(element)}`;
}

function hash(value: string, seed: number): number {
  let result = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result;
}

export function elementNodeId(element: Element): string {
  const path = elementPath(element);
  return `pm-${hash(path, 2166136261).toString(36)}-${hash(path, 2246822507).toString(36)}`;
}

function directText(element: Element): string {
  return compact([...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent || '')
    .join(' '));
}

function referencedText(element: Element): string {
  const ids = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  return compact(ids.map((id) => element.ownerDocument.getElementById(id)?.textContent || '').join(' '));
}

function associatedLabel(element: Element): string {
  const id = element.id;
  if (id) {
    const match = [...element.ownerDocument.querySelectorAll('label')]
      .find((candidate) => candidate.getAttribute('for') === id);
    if (match) return compact(match.textContent || '');
  }
  return compact(element.closest('label')?.textContent || '');
}

function accessibleName(element: Element): string {
  const aria = compact(element.getAttribute('aria-label') || '');
  if (aria) return aria;
  const referenced = referencedText(element);
  if (referenced) return referenced;
  const label = associatedLabel(element);
  if (label) return label;
  const name = tag(element);
  if (name === 'img') return compact(element.getAttribute('alt') || '');
  if (name === 'input' && ['button', 'submit', 'reset'].includes((element.getAttribute('type') || '').toLowerCase())) {
    return compact(element.getAttribute('value') || '');
  }
  if (controls.has(name) || content.has(name)) {
    const contents = compact(element.textContent || '');
    if (contents) return contents;
  }
  return compact(element.getAttribute('title') || element.getAttribute('placeholder') || '');
}

function stableIdentifier(value: string): string {
  const result = compact(value, 80);
  if (!result || !/[a-z]/i.test(result) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(result)
    || /\d{7,}/.test(result)) return '';
  return result;
}

function stableSignals(element: Element): string[] {
  const values: string[] = [];
  for (const attribute of [...element.attributes]) {
    if (attribute.name === 'id' || attribute.name === 'name' || attribute.name === 'title'
      || attribute.name === 'placeholder' || attribute.name === 'data-testid'
      || attribute.name === 'data-test' || attribute.name === 'data-qa' || attribute.name === 'data-cy') {
      const value = stableIdentifier(attribute.value);
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function humanize(value: string): string {
  return compact(value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'))
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function nearbyContainerLabel(element: Element): string {
  const preferred = new Set(['legend', 'summary', 'caption', 'figcaption', ...headings]);
  const scan = (parent: Element, depth: number): string => {
    for (const child of directChildren(parent)) {
      if (preferred.has(tag(child))) {
        const value = accessibleName(child) || directText(child);
        if (value) return value;
      }
    }
    if (depth <= 0) return '';
    for (const child of directChildren(parent)) {
      if (containers.has(tag(child))) continue;
      const value = scan(child, depth - 1);
      if (value) return value;
    }
    return '';
  };
  return containers.has(tag(element)) ? scan(element, 2) : '';
}

function structuralName(element: Element): string {
  return accessibleName(element) || nearbyContainerLabel(element);
}

function inferredRole(element: Element): string {
  const explicit = compact(element.getAttribute('role') || '');
  if (explicit) return explicit.split(/\s+/)[0] || '';
  const name = tag(element);
  const roles: Record<string, string> = {
    a: element.hasAttribute('href') ? 'link' : '', article: 'article', aside: 'complementary', button: 'button',
    dialog: 'dialog', footer: 'contentinfo', form: 'form', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading', header: 'banner', img: 'img', li: 'listitem', main: 'main',
    nav: 'navigation', ol: 'list', option: 'option', progress: 'progressbar', select: 'combobox', table: 'table',
    textarea: 'textbox', ul: 'list',
  };
  if (name !== 'input') return roles[name] || '';
  const type = (element.getAttribute('type') || 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'range') return 'slider';
  if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
  return 'textbox';
}

function isMeaningful(element: Element): boolean {
  const name = tag(element);
  return containers.has(name)
    || controls.has(name)
    || content.has(name)
    || Boolean(inferredRole(element))
    || Boolean(accessibleName(element))
    || element.hasAttribute('contenteditable');
}

function mappedChildren(element: Element): Element[] {
  const result: Element[] = [];
  const visit = (candidate: Element): void => {
    if (isMeaningful(candidate)) result.push(candidate);
    else directChildren(candidate).forEach(visit);
  };
  directChildren(element).forEach(visit);
  return result;
}

function parentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

function pathBoundary(element: Element): boolean {
  const name = tag(element);
  if (name === 'html' || name === 'body') return false;
  if (!containers.has(name)) return false;
  return pathLandmarks.has(name) || Boolean(structuralName(element)) || stableSignals(element).length > 0;
}

function pathParent(element: Element): Element | null {
  let parent = parentElement(element);
  while (parent && !pathBoundary(parent)) parent = parentElement(parent);
  return parent;
}

function supportNode(element: Element): boolean {
  const name = tag(element);
  if (name === 'label') {
    if (element.getAttribute('for')) return true;
    return directChildren(element).some((child) => controls.has(tag(child)));
  }
  if (!headings.has(name) && name !== 'legend' && name !== 'caption' && name !== 'figcaption') return false;
  const parent = pathParent(element);
  return Boolean(parent && structuralName(parent) === accessibleName(element));
}

function pathAddressable(element: Element): boolean {
  const name = tag(element);
  if (name === 'html' || name === 'body') return false;
  return pathBoundary(element) || controls.has(name) || content.has(name)
    || Boolean(inferredRole(element)) || Boolean(structuralName(element))
    || stableSignals(element).length > 0 || element.hasAttribute('contenteditable');
}

function cleanSegment(value: string): string {
  return compact(value, 80).replace(/\//g, ' - ').replace(/[\[\]]/g, '').trim();
}

function baseSemanticSegment(element: Element): string {
  const name = tag(element);
  if (name === 'html') return 'Document';
  if (name === 'body') return 'Body';
  const semantic = structuralName(element);
  if (supportNode(element) && semantic) {
    const suffix = name === 'label' ? 'Label' : headings.has(name) ? 'Heading' : humanize(name);
    return cleanSegment(`${semantic} ${suffix}`);
  }
  if (semantic) return cleanSegment(semantic);
  const role = inferredRole(element);
  if (pathLandmarks.has(name) && role) return cleanSegment(humanize(role));
  const stable = stableSignals(element)[0];
  if (stable) return cleanSegment(humanize(stable));
  return cleanSegment(humanize(role || name));
}

function normalizedSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function semanticSiblings(element: Element): Element[] {
  const parent = pathParent(element);
  const base = normalizedSignal(baseSemanticSegment(element));
  return allElements(element.ownerDocument).filter((candidate) => (
    pathAddressable(candidate) && pathParent(candidate) === parent
      && normalizedSignal(baseSemanticSegment(candidate)) === base
  ));
}

function semanticSegment(element: Element): string {
  const base = baseSemanticSegment(element);
  const siblings = semanticSiblings(element);
  return siblings.length > 1 ? `${base}[${Math.max(1, siblings.indexOf(element) + 1)}]` : base;
}

export function elementSemanticPath(element: Element): string {
  if (tag(element) === 'html') return 'Document';
  if (tag(element) === 'body') return 'Body';
  const parts = [semanticSegment(element)];
  let parent = pathParent(element);
  while (parent) {
    parts.unshift(semanticSegment(parent));
    parent = pathParent(parent);
  }
  return parts.join('/');
}

export function elementLogicalPath(element: Element): string {
  return elementSemanticPath(element);
}

function resolvedUrl(element: Element, attribute: 'href' | 'src'): string | undefined {
  const value = element.getAttribute(attribute);
  if (!value) return undefined;
  try {
    return new URL(value, element.ownerDocument.baseURI).href;
  } catch {
    return value;
  }
}

function nodeKind(element: Element): PageMapNode['kind'] {
  const name = tag(element);
  if (name === 'html' || name === 'body') return 'document';
  if (controls.has(name) || element.hasAttribute('contenteditable')) return 'control';
  if (containers.has(name)) return 'container';
  return 'content';
}

export function describeElement(element: Element): PageMapNode {
  const children = mappedChildren(element);
  const semanticPath = elementSemanticPath(element);
  const node: PageMapNode = {
    nodeId: elementNodeId(element), path: semanticPath, domPath: elementPath(element),
    semanticPath, logicalPath: semanticPath, tag: tag(element),
    kind: nodeKind(element), childCount: children.length, expandable: children.length > 0, shadow: Boolean(element.shadowRoot),
  };
  const domId = element.id.trim();
  const role = inferredRole(element);
  const name = structuralName(element);
  const label = associatedLabel(element);
  const text = directText(element);
  const href = resolvedUrl(element, 'href');
  const src = resolvedUrl(element, 'src');
  const type = compact(element.getAttribute('type') || '');
  if (domId) node.domId = domId;
  if (role) node.role = role;
  if (name) node.name = name;
  if (label && label !== name) node.label = label;
  if (text && text !== name) node.text = text;
  if (type) node.type = type;
  if (href) node.href = href;
  if (src) node.src = src;
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') node.disabled = true;
  if ('checked' in element && typeof element.checked === 'boolean') node.checked = element.checked;
  if ('selected' in element && typeof element.selected === 'boolean') node.selected = element.selected;
  const expanded = element.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') node.expanded = expanded === 'true';
  return node;
}

function parseSegment(value: string): { name: string; index: number } {
  const match = /^([a-z][a-z0-9:_-]*)\[([1-9][0-9]*)\]$/i.exec(value);
  if (!match) throw new DomFault('PATH', `Invalid DOM path segment: ${value}`);
  return { name: (match[1] as string).toLowerCase(), index: Number(match[2]) };
}

function descend(root: Document | Element | ShadowRoot, source: string): Element {
  let current: Document | Element | ShadowRoot = root;
  let found: Element | undefined;
  for (const raw of source.split('/').filter(Boolean)) {
    const part = parseSegment(raw);
    const candidates = [...('children' in current ? current.children : [])].filter((element) => tag(element) === part.name);
    found = candidates[part.index - 1];
    if (!found) throw new DomFault('MISSING', `DOM path does not exist at ${raw}.`);
    current = found;
  }
  if (!found) throw new DomFault('PATH', 'DOM path must identify an element.');
  return found;
}

function allElements(document: Document): Element[] {
  const result: Element[] = [];
  const visit = (element: Element): void => {
    if (!included(element)) return;
    result.push(element);
    directChildren(element).forEach(visit);
  };
  if (document.documentElement) visit(document.documentElement);
  return result;
}

function candidate(element: Element): object {
  const node = describeElement(element);
  return {
    nodeId: node.nodeId, path: node.path, domPath: node.domPath, tag: node.tag,
    role: node.role, name: node.name, label: node.label, text: node.text,
  };
}

type SemanticPathSegment = { value: string; normalized: string; index?: number };

function parseSemanticPath(value: string): SemanticPathSegment[] {
  const source = value.trim().replace(/^\/+|\/+$/g, '');
  if (!source) throw new DomFault('PATH', 'Semantic path must be a nonempty slash-separated path.');
  const values = source.split('/');
  if (values.length > 20 || values.some((item) => !item.trim() || item.trim().length > 120)) {
    throw new DomFault('PATH', 'Semantic path must contain 1-20 nonempty segments of at most 120 characters.');
  }
  return values.map((raw) => {
    const match = /^(.*?)(?:\[([1-9][0-9]*)\])?$/.exec(raw.trim());
    const value = match?.[1]?.trim() || '';
    const normalized = normalizedSignal(value);
    if (!normalized) throw new DomFault('PATH', `Semantic path segment is invalid: ${raw}`);
    return { value, normalized, ...(match?.[2] ? { index: Number(match[2]) } : {}) };
  });
}

function semanticSignals(element: Element): string[] {
  const preferred = baseSemanticSegment(element);
  const stable = stableSignals(element);
  if (supportNode(element)) return [preferred, ...stable, ...stable.map(humanize)];
  return [
    preferred,
    structuralName(element),
    accessibleName(element),
    associatedLabel(element),
    directText(element),
    inferredRole(element),
    tag(element),
    ...stable,
    ...stable.map(humanize),
  ].filter(Boolean);
}

function semanticChildren(document: Document, parent: Element | null): Element[] {
  return allElements(document).filter((element) => pathAddressable(element) && pathParent(element) === parent);
}

function matchSemanticSegment(elements: Element[], segment: SemanticPathSegment): Element[] {
  const matches = elements.filter((element) => semanticSignals(element)
    .some((signal) => normalizedSignal(signal) === segment.normalized));
  if (segment.index === undefined) return matches;
  const grouped = new Map<Element | null, Element[]>();
  for (const element of matches) {
    const parent = pathParent(element);
    const values = grouped.get(parent) || [];
    values.push(element);
    grouped.set(parent, values);
  }
  const index = (segment.index as number) - 1;
  return [...grouped.values()].flatMap((values) => values[index] ? [values[index] as Element] : []);
}

export function resolveSemanticPath(document: Document, source: string): Element {
  const segments = parseSemanticPath(source);
  const whole = segments.map((segment) => segment.normalized).join('/');
  if (whole === 'document') {
    if (!document.documentElement) throw new DomFault('NOT_FOUND', 'The page has no document element.', { path: source });
    return document.documentElement;
  }
  if (whole === 'body') {
    if (!document.body) throw new DomFault('NOT_FOUND', 'The page has no body element.', { path: source });
    return document.body;
  }

  let parents: Array<Element | null> = [null];
  let matches: Element[] = [];
  for (let position = 0; position < segments.length; position += 1) {
    const segment = segments[position] as SemanticPathSegment;
    const pool = parents.flatMap((parent) => semanticChildren(document, parent));
    matches = matchSemanticSegment(pool, segment);
    if (matches.length === 0) {
      const shown = pool.slice(0, 10).map(candidate);
      throw new DomFault(
        'NOT_FOUND',
        `Semantic path was not found at segment ${position + 1} (${segment.value}): ${source}`,
        {
          path: source,
          segment: segment.value,
          position: position + 1,
          candidates: shown,
          omitted: Math.max(0, pool.length - shown.length),
        },
      );
    }
    parents = matches;
  }
  if (matches.length > 1) {
    const shown = matches.slice(0, 10).map(candidate);
    throw new DomFault(
      'AMBIGUOUS_PATH',
      `Semantic path matches ${matches.length} elements: ${source}`,
      { path: source, total: matches.length, candidates: shown, omitted: Math.max(0, matches.length - shown.length) },
    );
  }
  return matches[0] as Element;
}

function unique(matches: Element[], description: string): Element {
  if (matches.length === 0) throw new DomFault('MISSING', `No element matches ${description}.`);
  if (matches.length > 1) {
    const shown = matches.slice(0, 10).map(candidate);
    throw new DomFault(
      'AMBIGUOUS',
      `${matches.length} elements match ${description}. Refine the locator using nodeId, path, role, name, or another semantic field.`,
      { total: matches.length, candidates: shown, omitted: Math.max(0, matches.length - shown.length) },
    );
  }
  return matches[0] as Element;
}

function stringField(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new DomFault('LOOKUP', `${name} must be a nonempty string.`);
  return compact(value, 500);
}

function semanticMatches(document: Document, locator: DomLocator): Element[] {
  const role = stringField(locator.role, 'role')?.toLowerCase();
  const name = stringField(locator.name, 'name');
  const label = stringField(locator.label, 'label');
  const text = stringField(locator.text, 'text');
  const tagName = stringField(locator.tag, 'tag')?.toLowerCase();
  if (!role && !name && !label && !text && !tagName) {
    throw new DomFault('LOOKUP', 'A semantic locator needs at least one of role, name, label, text, or tag.');
  }
  if (locator.exact !== undefined && typeof locator.exact !== 'boolean') throw new DomFault('LOOKUP', 'exact must be a boolean.');
  const exact = locator.exact === true;
  const matches = (actual: string, expected: string | undefined): boolean => {
    if (expected === undefined) return true;
    return exact ? actual.toLowerCase() === expected.toLowerCase() : actual.toLowerCase().includes(expected.toLowerCase());
  };
  return allElements(document).filter((element) => (
    (!role || inferredRole(element).toLowerCase() === role)
    && matches(accessibleName(element), name)
    && matches(associatedLabel(element), label)
    && matches(compact(element.textContent || '', 1000), text)
    && (!tagName || tag(element) === tagName)
  ));
}

function selectorMatches(document: Document, selector: string): Element[] {
  const result: Element[] = [];
  try {
    for (const element of allElements(document)) if (element.matches(selector)) result.push(element);
  } catch (error) {
    throw new DomFault('SELECTOR', `Invalid CSS selector: ${(error as Error).message}`);
  }
  return result;
}

function resolveDomPath(document: Document, source: unknown): Element {
  const path = stringField(source, 'domPath') as string;
  if (!/^\/[a-z][a-z0-9:_-]*\[[1-9][0-9]*\](?:\/|$)/i.test(path)) {
    throw new DomFault('PATH', 'domPath must be an absolute indexed path returned by Qlyx.');
  }
  const sections = path.split('::shadow/');
  let current = descend(document, sections.shift() as string);
  for (const section of sections) {
    if (!current.shadowRoot) throw new DomFault('MISSING', `DOM path expects a shadow root at ${elementPath(current)}.`);
    current = descend(current.shadowRoot, section);
  }
  return current;
}

export function locateElement(document: Document, locator: DomLocator): Element {
  if (locator.nodeId !== undefined) {
    const id = stringField(locator.nodeId, 'nodeId') as string;
    return unique(allElements(document).filter((element) => elementNodeId(element) === id), `nodeId ${id}`);
  }
  if (locator.domPath !== undefined) return resolveDomPath(document, locator.domPath);
  if (locator.path !== undefined) {
    const path = stringField(locator.path, 'path') as string;
    return /^\/[a-z][a-z0-9:_-]*\[[1-9][0-9]*\](?:\/|$)/i.test(path)
      ? resolveDomPath(document, path)
      : resolveSemanticPath(document, path);
  }
  if (locator.semanticPath !== undefined) {
    return resolveSemanticPath(document, stringField(locator.semanticPath, 'semanticPath') as string);
  }
  if (locator.logicalPath !== undefined) {
    return resolveSemanticPath(document, stringField(locator.logicalPath, 'logicalPath') as string);
  }
  if (locator.selector !== undefined) {
    const selector = stringField(locator.selector, 'selector') as string;
    return unique(selectorMatches(document, selector), `selector ${selector}`);
  }
  if (locator.role !== undefined || locator.name !== undefined || locator.label !== undefined
    || locator.text !== undefined || locator.tag !== undefined) {
    return unique(semanticMatches(document, locator), 'the semantic locator');
  }
  if (!document.documentElement) throw new DomFault('MISSING', 'The page has no document element.');
  return document.documentElement;
}

type MapBudget = { remaining: number; returned: number; omitted: number; truncated: boolean };

function mapElement(element: Element, depth: number, budget: MapBudget): PageMapNode {
  const node = describeElement(element);
  budget.remaining -= 1;
  budget.returned += 1;
  if (depth <= 0 || !node.expandable) return node;
  const children = mappedChildren(element);
  const expanded: PageMapNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    if (budget.remaining <= 0) {
      budget.omitted += children.length - index;
      budget.truncated = true;
      break;
    }
    expanded.push(mapElement(children[index] as Element, depth - 1, budget));
  }
  if (expanded.length > 0) node.children = expanded;
  return node;
}

function pageMap(document: Document, locator: DomLocator, nodes: number, depth: number): object {
  const element = locateElement(document, locator);
  const budget: MapBudget = { remaining: nodes, returned: 0, omitted: 0, truncated: false };
  const map = mapElement(element, depth, budget);
  const { children, ...node } = map;
  return {
    map,
    node,
    children: children || [],
    limits: { depth, nodes },
    returned: budget.returned,
    omitted: budget.omitted,
    truncated: budget.truncated,
  };
}

export function expandDocument(document: Document, locator: DomLocator = {}, nodes = 80, depth = 1): object {
  return pageMap(document, locator, integer(nodes, 80, 1, maximumNodes, 'nodes'), integer(depth, 1, 0, maximumDepth, 'depth'));
}

export function snapshotDocument(document: Document, nodes = 80, depth = 2): object {
  return {
    url: document.location.href,
    title: document.title,
    ...pageMap(document, {}, integer(nodes, 80, 1, maximumNodes, 'nodes'), integer(depth, 2, 0, maximumDepth, 'depth')),
  };
}

export function findDocument(document: Document, request: DomRequest): object {
  const matches = semanticMatches(document, request);
  const limit = integer(request.limit, 20, 1, 50, 'limit');
  if (request.all !== undefined && typeof request.all !== 'boolean') throw new DomFault('LOOKUP', 'all must be a boolean.');
  if (request.all !== true) {
    const element = unique(matches, 'the semantic locator');
    return { match: describeElement(element), total: 1, ambiguous: false };
  }
  return {
    matches: matches.slice(0, limit).map(describeElement), total: matches.length,
    omitted: Math.max(0, matches.length - limit), ambiguous: matches.length > 1,
  };
}

function sourceFor(element: Element, format: string): string {
  if (format === 'html') return element.outerHTML;
  if (format === 'text') return compact(element.textContent || '', Number.MAX_SAFE_INTEGER);
  if (format === 'attributes') {
    return JSON.stringify(Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])), null, 2);
  }
  throw new DomFault('FORMAT', 'format must be text, html, or attributes.');
}

export function readDocument(document: Document, request: DomRequest): object {
  const element = locateElement(document, request);
  const format = typeof request.format === 'string' ? request.format : 'text';
  if (format === 'html' && element === document.documentElement) {
    const nodes = integer(request.nodes ?? request.children, 80, 1, maximumNodes, 'nodes');
    const depth = integer(request.depth, 1, 0, maximumDepth, 'depth');
    return {
      format: 'page-map',
      requestedFormat: 'html',
      collapsed: true,
      reason: 'Complete-document HTML stays local. Qlyx returned a bounded semantic map for incremental exploration.',
      next: 'Call browser_expand with a returned path or nodeId, then use browser_extract on the identified subtree.',
      ...snapshotDocument(document, nodes, depth),
    };
  }
  const source = sourceFor(element, format);
  const offset = integer(request.offset, 0, 0, source.length, 'offset');
  const limit = integer(request.limit, 65536, 1, 262144, 'limit');
  const value = source.slice(offset, offset + limit);
  const next = offset + value.length < source.length ? offset + value.length : null;
  return {
    node: describeElement(element), format, content: value,
    bytes: new TextEncoder().encode(value).byteLength,
    page: { offset, limit, total: source.length, next },
  };
}

export function attributesDocument(document: Document, request: DomRequest): object {
  const element = locateElement(document, request);
  return {
    node: describeElement(element),
    attributes: Object.fromEntries([...element.attributes].map((item) => [item.name, item.value])),
  };
}

export function dumpDocument(document: Document, request: DomRequest): object {
  const element = locateElement(document, request);
  const format = typeof request.format === 'string' ? request.format : 'html';
  let value = sourceFor(element, format);
  if (format === 'html' && element === document.documentElement && document.doctype) value = `<!doctype ${document.doctype.name}>\n${value}`;
  const bytes = new TextEncoder().encode(value).byteLength;
  const maximum = integer(request.max, 262144, 1, 1048576, 'max');
  if (bytes > maximum) {
    throw new DomFault('SIZE', `Selected DOM content is ${bytes} bytes; the archive limit is ${maximum}. Dump a smaller path.`);
  }
  return { node: describeElement(element), format, content: value, bytes };
}

function dispatch(element: Element, type: string): void {
  const EventConstructor = element.ownerDocument.defaultView?.Event;
  if (EventConstructor) element.dispatchEvent(new EventConstructor(type, { bubbles: true, composed: true }));
}

function writeText(element: Element, text: string, replace: boolean): void {
  const name = tag(element);
  if ('focus' in element && typeof element.focus === 'function') element.focus();
  let next = text;
  if (name === 'input' || name === 'textarea') {
    const control = element as HTMLInputElement | HTMLTextAreaElement;
    next = replace ? text : `${control.value}${text}`;
    const view = element.ownerDocument.defaultView;
    const prototype = name === 'textarea' ? view?.HTMLTextAreaElement.prototype : view?.HTMLInputElement.prototype;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : undefined;
    if (setter) setter.call(control, next);
    else control.value = next;
  } else if (element.hasAttribute('contenteditable')) {
    const current = element.textContent || '';
    next = replace ? text : `${current}${text}`;
    element.textContent = next;
  } else {
    throw new DomFault('INTERACTION', 'Typing requires an input, textarea, or contenteditable element.');
  }
  const InputEventConstructor = element.ownerDocument.defaultView?.InputEvent;
  if (InputEventConstructor) {
    element.dispatchEvent(new InputEventConstructor('input', {
      bubbles: true,
      composed: true,
      inputType: replace ? 'insertReplacementText' : 'insertText',
      data: text,
    }));
  } else dispatch(element, 'input');
  dispatch(element, 'change');
}

export function interactDocument(document: Document, request: DomRequest): object {
  const operation = stringField(request.operation, 'operation')?.toLowerCase();
  if (!operation || !['click', 'focus', 'fill', 'type', 'select', 'check', 'uncheck'].includes(operation)) {
    throw new DomFault('INTERACTION', 'operation must be click, focus, fill, type, select, check, or uncheck.');
  }
  const locator = operation === 'type' && request.text !== undefined ? { ...request, text: undefined } : request;
  const element = locateElement(document, locator);
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
    throw new DomFault('DISABLED', 'The selected element is disabled.');
  }
  const name = tag(element);
  if (operation === 'click') {
    if (!('click' in element) || typeof element.click !== 'function') throw new DomFault('INTERACTION', 'The selected element cannot be clicked.');
    element.click();
  } else if (operation === 'focus') {
    if (!('focus' in element) || typeof element.focus !== 'function') throw new DomFault('INTERACTION', 'The selected element cannot be focused.');
    element.focus();
  } else if (operation === 'fill' || operation === 'type') {
    const text = request.text ?? request.value;
    if (typeof text !== 'string') throw new DomFault('INTERACTION', `${operation} requires string text.`);
    if (request.replace !== undefined && typeof request.replace !== 'boolean') {
      throw new DomFault('INTERACTION', 'replace must be a boolean.');
    }
    writeText(element, text, operation === 'fill' || request.replace !== false);
  } else if (operation === 'select') {
    if (name !== 'select' || typeof request.value !== 'string') {
      throw new DomFault('INTERACTION', 'select requires a select element and string value.');
    }
    const select = element as HTMLSelectElement;
    if (![...select.options].some((option) => option.value === request.value)) {
      throw new DomFault('MISSING', `The selected control has no option with value: ${request.value}`);
    }
    select.value = request.value;
    dispatch(element, 'input');
    dispatch(element, 'change');
  } else {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (name !== 'input' || !['checkbox', 'radio'].includes(type)) {
      throw new DomFault('INTERACTION', `${operation} requires a checkbox or radio input.`);
    }
    if (operation === 'uncheck' && type === 'radio') throw new DomFault('INTERACTION', 'A radio input cannot be unchecked directly.');
    input.checked = operation === 'check';
    dispatch(element, 'input');
    dispatch(element, 'change');
  }
  return { interaction: operation, node: describeElement(element), url: document.location.href };
}

function coordinate(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100000 || value > 100000) {
    throw new DomFault('SCROLL', `${name} must be a finite number from -100000 through 100000.`);
  }
  return value;
}

function hasLocator(request: DomRequest): boolean {
  return ['nodeId', 'path', 'domPath', 'semanticPath', 'logicalPath', 'selector', 'role', 'name', 'label', 'text', 'tag']
    .some((field) => request[field as keyof DomRequest] !== undefined);
}

export function scrollDocument(document: Document, request: DomRequest): object {
  const behavior = request.behavior === undefined ? 'auto' : request.behavior;
  if (behavior !== 'auto' && behavior !== 'smooth') throw new DomFault('SCROLL', 'behavior must be auto or smooth.');
  const view = document.defaultView;
  if (!view) throw new DomFault('SCROLL', 'The page has no scrollable window.');
  if (hasLocator(request)) {
    const element = locateElement(document, request);
    const block = request.block === undefined ? 'center' : request.block;
    if (!['start', 'center', 'end', 'nearest'].includes(String(block))) {
      throw new DomFault('SCROLL', 'block must be start, center, end, or nearest.');
    }
    if (!('scrollIntoView' in element) || typeof element.scrollIntoView !== 'function') {
      throw new DomFault('SCROLL', 'The selected element cannot be scrolled into view.');
    }
    element.scrollIntoView({ behavior, block: block as ScrollLogicalPosition, inline: 'nearest' });
    return { scroll: { mode: 'element', x: view.scrollX, y: view.scrollY }, node: describeElement(element) };
  }
  const x = coordinate(request.x, 0, 'x');
  const y = coordinate(request.y, 600, 'y');
  if (typeof view.scrollBy !== 'function') throw new DomFault('SCROLL', 'The page window cannot be scrolled.');
  view.scrollBy({ left: x, top: y, behavior });
  return { scroll: { mode: 'viewport', requested: { x, y }, x: view.scrollX, y: view.scrollY } };
}

function handle(document: Document, request: DomRequest): object {
  const nodes = integer(request.nodes ?? request.children, 80, 1, maximumNodes, 'nodes');
  const depth = integer(request.depth, request.action === 'snapshot' ? 2 : 1, 0, maximumDepth, 'depth');
  if (request.action === 'snapshot') return snapshotDocument(document, nodes, depth);
  if (request.action === 'expand') return expandDocument(document, request, nodes, depth);
  if (request.action === 'find') return findDocument(document, request);
  if (request.action === 'read') return readDocument(document, request);
  if (request.action === 'attributes') return attributesDocument(document, request);
  if (request.action === 'interact') return interactDocument(document, request);
  if (request.action === 'scroll') return scrollDocument(document, request);
  if (request.action === 'dump') return dumpDocument(document, request);
  throw new DomFault('ACTION', `Unknown DOM inspection action: ${String(request.action || '')}`);
}

function install(): void {
  const state = window as typeof window & { __qlyxBrowseInstalled__?: boolean };
  if (state.__qlyxBrowseInstalled__) return;
  state.__qlyxBrowseInstalled__ = true;
  chrome.runtime.onMessage.addListener((message: DomRequest, _sender, respond) => {
    if (message.kind !== 'qlyx:browser') return false;
    try {
      respond({ ok: true, data: handle(document, message) });
    } catch (error) {
      const fault = error instanceof DomFault ? error : new DomFault('DOM', (error as Error).message);
      respond({ ok: false, error: { code: fault.code, message: fault.message, details: fault.details } });
    }
    return false;
  });
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined') install();
