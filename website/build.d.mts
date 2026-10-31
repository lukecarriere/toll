/** Types for website/build.mjs. NodeNext resolves a .mjs import to this .d.mts file. */

export interface Page {
  file: string;
  nav: string;
  description: string;
  closingLine?: boolean;
}

/** Page lists. `find` returns the page: callers look up a row the list always contains. */
export interface PageList {
  length: number;
  [index: number]: Page;
  map<U>(callback: (page: Page, index: number, list: PageList) => U): U[];
  find(predicate: (page: Page, index: number, list: PageList) => boolean): Page;
  [Symbol.iterator](): Iterator<Page>;
}

export const PAGES: PageList;
export const DOC_PAGES: PageList;
export const LEGAL_PAGES: PageList;

export const HOME: {
  title: string;
  description: string;
  kicker: string;
  h1: string[];
  line: string;
  meta: [string, string][];
  plate: string;
  alt: string;
};

export function pagePath(file: string): string;
export function discoveryFiles(): string[];
export function cliSiteRaw(env?: NodeJS.ProcessEnv): string | undefined;
export function build(out?: string, site?: string | null, warn?: (message: string) => void): string;
