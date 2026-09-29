/**
 * Prepare the local S3-compatible server for uploads, once after `docker compose up`:
 *
 *   pnpm storage:init
 *
 * Creates S3_BUCKET if it is missing and lets browsers upload to it (a CORS rule), so avatar,
 * cover and document uploads work from the app, Expo web and the admin console. Safe to re-run.
 *
 * Local development only: it refuses to run without S3_ENDPOINT, so it can never change the
 * real AWS bucket (production CORS is set on the bucket itself, for the real origins).
 */
import 'dotenv/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

async function main() {
  const endpoint = process.env.S3_ENDPOINT?.replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? 'us-east-1';
  if (!endpoint) {
    throw new Error(
      'S3_ENDPOINT is not set. This script is for the local S3 server only (see DEVELOPMENT notes in .env.example).',
    );
  }
  if (!bucket) throw new Error('Set S3_BUCKET, e.g. pic-events-dev.');
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to the local server keys (RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY in docker-compose.yml).',
    );
  }

  const s3 = new S3Client({ region, endpoint, forcePathStyle: true });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`Bucket ${bucket} already exists.`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket ${bucket}.`);
  }

  // Any origin may PUT/GET with a signed URL: the signature is the permission, and local
  // clients run on changing ports (Expo web, the console, a phone on the LAN).
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['*'],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  );
  console.log(
    `Uploads ready: ${endpoint}/${bucket} (private; access by signed URL).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
