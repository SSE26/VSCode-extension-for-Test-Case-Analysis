import { mkdir, readFile, rename, writeFile } from "fs/promises";
import * as path from "path";
import type {
  PersistedTestProfile,
  TestProfileCacheFile,
  TestProfileIdentity
} from "./testCaseAnalysisTypes";

const CACHE_DIRECTORY_NAME = ".test-case-analysis";
const CACHE_FILE_NAME = "profile-cache.json";
const CACHE_VERSION = 1 as const;
const SAME_HASH_OLD_WEIGHT = 0.4;
const SAME_HASH_NEW_WEIGHT = 0.6;
const CHANGED_HASH_OLD_WEIGHT = 0.3;
const CHANGED_HASH_NEW_WEIGHT = 0.7;

export type CacheFlushResult = {
  wroteFile: boolean;
  cacheFilePath?: string;
  reason: "written" | "no-cache-path" | "no-pending-changes";
};

export class TestProfileCache {
  private hasPendingChanges = false;

  private constructor(
    private readonly cacheFilePath: string | undefined,
    private readonly cacheFile: TestProfileCacheFile
  ) {}

  static async load(workspaceRootPath: string | undefined): Promise<TestProfileCache> {
    if (!workspaceRootPath) {
      return new TestProfileCache(undefined, createEmptyCacheFile());
    }

    const cacheFilePath = path.join(workspaceRootPath, CACHE_DIRECTORY_NAME, CACHE_FILE_NAME);

    try {
      const rawFile = await readFile(cacheFilePath, "utf8");
      const parsedFile = JSON.parse(rawFile) as Partial<TestProfileCacheFile>;
      if (parsedFile.version !== CACHE_VERSION || parsedFile.entries === undefined || parsedFile.entries === null) {
        return new TestProfileCache(cacheFilePath, createEmptyCacheFile());
      }

      return new TestProfileCache(cacheFilePath, {
        version: CACHE_VERSION,
        entries: parsedFile.entries
      });
    } catch {
      return new TestProfileCache(cacheFilePath, createEmptyCacheFile());
    }
  }

  updateProfile(testProfile: TestProfileIdentity, measuredEnergyJ: number): number {
    if (!canPersistTestProfile(testProfile) || this.cacheFilePath === undefined) {
      return measuredEnergyJ;
    }

    const cacheKey = getCacheKey(testProfile);
    const existingProfile = this.cacheFile.entries[cacheKey];
    const weightedEnergyJ = computeWeightedEnergy(existingProfile, testProfile.sourceHash, measuredEnergyJ);

    this.cacheFile.entries[cacheKey] = createPersistedProfile(
      testProfile,
      existingProfile,
      weightedEnergyJ,
      measuredEnergyJ
    );
    this.hasPendingChanges = true;
    return weightedEnergyJ;
  }

  getPersistedProfile(testProfile: TestProfileIdentity): PersistedTestProfile | undefined {
    if (!canPersistTestProfile(testProfile)) {
      return undefined;
    }

    return this.cacheFile.entries[getCacheKey(testProfile)];
  }

  async flush(): Promise<CacheFlushResult> {
    if (this.cacheFilePath === undefined) {
      return {
        wroteFile: false,
        reason: "no-cache-path"
      };
    }

    if (!this.hasPendingChanges) {
      return {
        wroteFile: false,
        cacheFilePath: this.cacheFilePath,
        reason: "no-pending-changes"
      };
    }

    const cacheDirectory = path.dirname(this.cacheFilePath);
    const temporaryFilePath = `${this.cacheFilePath}.tmp`;

    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(temporaryFilePath, JSON.stringify(this.cacheFile, null, 2), "utf8");
    await rename(temporaryFilePath, this.cacheFilePath);
    this.hasPendingChanges = false;

    return {
      wroteFile: true,
      cacheFilePath: this.cacheFilePath,
      reason: "written"
    };
  }
}

export function getCacheKey(testProfile: Pick<TestProfileIdentity, "relativeFile" | "testName">): string {
  return `${testProfile.relativeFile}::${testProfile.testName}`;
}

export function computeWeightedEnergy(
  existingProfile: PersistedTestProfile | undefined,
  nextSourceHash: string,
  measuredEnergyJ: number
): number {
  if (existingProfile === undefined) {
    return measuredEnergyJ;
  }

  if (existingProfile.sourceHash === nextSourceHash) {
    return (existingProfile.weightedEnergyJ * SAME_HASH_OLD_WEIGHT) + (measuredEnergyJ * SAME_HASH_NEW_WEIGHT);
  }

  return (existingProfile.weightedEnergyJ * CHANGED_HASH_OLD_WEIGHT) + (measuredEnergyJ * CHANGED_HASH_NEW_WEIGHT);
}

function canPersistTestProfile(testProfile: TestProfileIdentity): testProfile is TestProfileIdentity & { sourceHash: string } {
  return testProfile.cacheable && testProfile.sourceHash !== undefined;
}

function createPersistedProfile(
  testProfile: TestProfileIdentity & { sourceHash: string },
  existingProfile: PersistedTestProfile | undefined,
  weightedEnergyJ: number,
  measuredEnergyJ: number
): PersistedTestProfile {
  return {
    relativeFile: testProfile.relativeFile,
    testName: testProfile.testName,
    sourceHash: testProfile.sourceHash,
    weightedEnergyJ,
    lastMeasuredEnergyJ: measuredEnergyJ,
    sampleCount: existingProfile?.sampleCount !== undefined ? existingProfile.sampleCount + 1 : 1,
    lastUpdatedAt: new Date().toISOString()
  };
}

function createEmptyCacheFile(): TestProfileCacheFile {
  return {
    version: CACHE_VERSION,
    entries: {}
  };
}
