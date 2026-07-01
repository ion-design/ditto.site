import { join } from "node:path";
import type { ArtifactStore } from "./types.js";
import { LocalArtifactStore } from "./local.js";
import { ObjectArtifactStore } from "./objectStore.js";
import { S3BlobClient, s3ConfigFromEnv } from "./s3.js";

/** Pick the artifact store from the environment: S3/R2 when S3_BUCKET is set,
 *  otherwise a local disk store (ARTIFACTS_DIR or ./local-data/artifacts). */
export function artifactStoreFromEnv(): ArtifactStore {
  const s3 = s3ConfigFromEnv();
  if (s3) return new ObjectArtifactStore(new S3BlobClient(s3));
  const dir = process.env.ARTIFACTS_DIR ?? join(process.cwd(), "local-data", "artifacts");
  return new LocalArtifactStore(dir);
}
