export const PUBLIC_PACKAGE_DIRS: string[];
export const DEFAULT_REGISTRY: string;

export function versionUrl(registry: string, name: string, version: string): string;

export function versionOnRegistry(
  name: string,
  version: string,
  options?: { registry?: string; fetchImpl?: typeof fetch },
): Promise<boolean>;

export function publishMissing(
  dirs: string[],
  options?: {
    registry?: string;
    fetchImpl?: typeof fetch;
    publish?: boolean;
    run?: (dir: string, pkg: { name: string; version: string }) => void | Promise<void>;
  },
): Promise<string[]>;
