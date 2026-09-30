import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function validateRelease(tag, git = (...args) => execFileSync('git',args,{encoding:'utf8'}).trim()) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) throw new Error('An existing version tag is required');
  const sha=git('rev-parse',`refs/tags/${tag}^{commit}`), head=git('rev-parse','HEAD');
  if (head!==sha) throw new Error('The checkout does not match the requested release tag');
  git('merge-base','--is-ancestor',sha,'origin/main');
  const version=tag.slice(1);
  for(const part of ['backend','frontend']) {
    const pkg=JSON.parse(readFileSync(`${part}/package.json`,'utf8'));
    const lock=JSON.parse(readFileSync(`${part}/package-lock.json`,'utf8'));
    if(pkg.version!==version || lock.version!==version || lock.packages[''].version!==version) throw new Error(`${part} package/lock version does not match ${tag}`);
  }
  const gradle=readFileSync('frontend/packages/android/app/build.gradle','utf8');
  if (!gradle.includes(`versionName "${version}"`)) throw new Error('Android versionName does not match the release');
  const mainVersion=JSON.parse(git('show','origin/main:frontend/package.json')).version;
  return {sha,tag,version,latest:!version.includes('-') && version===mainVersion};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const result=validateRelease(process.argv[2] || process.env.REQUESTED_TAG || process.env.GITHUB_REF_NAME);
  console.log(JSON.stringify(result));
  if(process.env.GITHUB_OUTPUT)for(const [key,value] of Object.entries(result))appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
}
