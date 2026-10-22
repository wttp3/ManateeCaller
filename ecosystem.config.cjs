/**
 * ManateeCaller PM2 entry.
 *
 *   pm2 start ecosystem.config.cjs --only manateecaller
 *
 * cwd stays the symlink path when DEPLOY_RELEASE_ROOT is set. Do not
 * realpath it: a reload must follow `current`, not one release directory.
 *
 * Runtime env is shared/.env on the host, linked into the release as .env.
 * The app reads that file at process start. Nothing secret is written here.
 */

const releaseRoot = process.env.DEPLOY_RELEASE_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: "manateecaller",
      cwd: releaseRoot,
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
