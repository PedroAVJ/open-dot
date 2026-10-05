#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDependencies } from './check_dependencies.ts';

// Offline local builds. This script does not authenticate, register devices,
// update provisioning, upload to Apple, install, or create an OTA manifest.
const root = fileURLToPath(new URL('../', import.meta.url));
const fork = resolve(root, '../f');
const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bundle = 'com.pedroavj.opendot.ios';
const minimum = '17.0';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('bun script/build_ios.ts [simulator|device|both] [--profile PATH] [--identity SHA1] [--keychain PATH] [--origin HTTPS_URL] [--version X.Y.Z] [--build N]');
  process.exit(0);
}
const target = args[0]?.startsWith('--') ? 'both' : args.shift() ?? 'both';
if (!['simulator', 'device', 'both'].includes(target)) throw new Error('Target must be simulator, device or both.');
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  if (!['--profile', '--identity', '--keychain', '--origin', '--version', '--build'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('Unknown option or missing value: ' + flag);
  }
  if (flags[flag] !== undefined) throw new Error('Duplicate option: ' + flag);
  flags[flag] = args[i + 1];
}
const origin = flags['--origin'] ?? 'https://pedros-mac-mini.tail90fb4c.ts.net:9453';
const originURL = new URL(origin);
if (originURL.protocol !== 'https:' || originURL.username || originURL.password || originURL.pathname !== '/' || originURL.search || originURL.hash) {
  throw new Error('--origin must be an HTTPS origin without credentials, path, query or fragment.');
}
const version = flags['--version'] ?? packageInfo.version;
const build = flags['--build'] ?? String(Math.floor(Date.now() / 1000));
if (!/^\d+(\.\d+){0,2}$/.test(version) || !/^\d+(\.\d+){0,2}$/.test(build)) throw new Error('--version and --build require one to three numbers.');
if (!existsSync(join(root, 'ios.bend'))) throw new Error('Missing ios.bend entrypoint.');
if (!existsSync(join(fork, 'bend2/std/F/apple/ios_shell.c'))) throw new Error('Missing fork UIKit host: bend2/std/F/apple/ios_shell.c.');

function run(command: string, parameters: string[], quiet = false): string {
  return execFileSync(command, parameters, {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, BEND_NO_TELEMETRY: '1' },
  }).trim();
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileDigest = (file: string) => digest(readFileSync(file));
function plist(value: unknown): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const item = (x: unknown): string => typeof x === 'string' ? '<string>' + escape(x) + '</string>'
    : typeof x === 'number' ? '<integer>' + x + '</integer>'
    : typeof x === 'boolean' ? x ? '<true/>' : '<false/>'
    : Array.isArray(x) ? '<array>' + x.map(item).join('') + '</array>'
    : '<dict>' + Object.entries(x as Record<string, unknown>).map(([k, v]) => '<key>' + escape(k) + '</key>' + item(v)).join('') + '</dict>';
  return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">' + item(value) + '</plist>\n';
}
const readPlist = (file: string) => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', file], true));
const match = (pattern: string, value: string) => pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
type Signing = { path: string; uuid: string; name: string; expires: string; team: string; appID: string; certificate: string; devices: number; entitlements: Record<string, unknown> };
function developmentSigning(): Signing {
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', ...(flags['--keychain'] ? [resolve(flags['--keychain'])] : [])], true);
  const valid = [...identities.matchAll(/\b([A-Fa-f0-9]{40}) "((?:Apple Development|iPhone Developer):[^"\n]+)"/g)].map(m => m[1].toUpperCase());
  if (flags['--identity']) {
    const requested = flags['--identity'].toUpperCase();
    if (!valid.includes(requested)) throw new Error('--identity must match an available Apple Development SHA1.');
    valid.splice(0, valid.length, requested);
  }
  const paths = flags['--profile'] ? [resolve(flags['--profile'])] : [
    join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
    join(homedir(), 'Library/MobileDevice/Provisioning Profiles'),
  ].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.mobileprovision')).sort().map(n => join(dir, n)) : []);
  for (const path of paths) {
    try {
      // Decode only public provisioning metadata; no account credentials are used.
      const cms = execFileSync('security', ['cms', '-D', '-i', path], { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const profile = JSON.parse(execFileSync('python3', ['-c', `import datetime,hashlib,json,plistlib,sys
p=plistlib.loads(sys.stdin.buffer.read())
print(json.dumps({k:p.get(k) for k in ['UUID','Name','Platform','TeamIdentifier','ApplicationIdentifierPrefix','Entitlements','ProvisionsAllDevices']} | {'ExpirationDate':p['ExpirationDate'].replace(tzinfo=datetime.timezone.utc).isoformat(),'ProvisionedDeviceCount':len(p.get('ProvisionedDevices',[])),'certificateSha1':[hashlib.sha1(c).hexdigest().upper() for c in p.get('DeveloperCertificates',[])]}))`], { input: cms, encoding: 'utf8' }));
      const e = profile.Entitlements ?? {};
      const team = profile.TeamIdentifier?.[0];
      const prefix = profile.ApplicationIdentifierPrefix?.[0];
      const appID = prefix + '.' + bundle;
      const certificate = profile.certificateSha1.find((c: string) => valid.includes(c));
      if (!profile.Platform?.includes('iOS') || !profile.ProvisionedDeviceCount || profile.ProvisionsAllDevices || e['get-task-allow'] !== true || new Date(profile.ExpirationDate).getTime() <= Date.now() || !team || !prefix || !certificate || !match(e['application-identifier'] ?? '', appID)) continue;
      if (!e['keychain-access-groups']?.some((group: string) => match(group, appID))) continue;
      return { path, uuid: profile.UUID, name: profile.Name, expires: profile.ExpirationDate, team, appID, certificate, devices: profile.ProvisionedDeviceCount,
        entitlements: { 'application-identifier': appID, 'com.apple.developer.team-identifier': team, 'get-task-allow': true, 'keychain-access-groups': [appID],
          ...(e['application-identifier'] === appID && ['development', 'production'].includes(e['aps-environment']) ? { 'aps-environment': e['aps-environment'] } : {}) } };
    } catch (problem) {
      if (flags['--profile']) throw new Error('Could not decode --profile as a cached development profile.', { cause: problem });
    }
  }
  throw new Error('No unexpired cached iOS development profile matches this app and an available development identity. No provisioning changes were made.');
}
const dependencies = verifyDependencies(root);
const signing = target === 'simulator' ? undefined : developmentSigning();
mkdirSync(join(root, 'dist'), { recursive: true });
const stage = mkdtempSync(join(root, 'dist/.ios-build-'));
const inputs: { name: string; sha256: string }[] = [];
function capture(from: string, to: string, name: string) {
  mkdirSync(dirname(to), { recursive: true });
  const bytes = readFileSync(from);
  writeFileSync(to, bytes);
  inputs.push({ name, sha256: digest(bytes) });
}
function files(directory: string): string[] {
  return readdirSync(directory).sort().flatMap(name => {
    const at = join(directory, name);
    return statSync(at).isDirectory() ? files(at) : [at];
  });
}
function checkout(directory: string) {
  return { commit: run('git', ['-C', directory, 'rev-parse', 'HEAD'], true), dirty: !!run('git', ['-C', directory, 'status', '--porcelain'], true) };
}

try {
  const source = join(stage, 'work/open-dot');
  const compiler = join(stage, 'work/f/bend2');
  mkdirSync(source, { recursive: true });
  const checkouts = { source: checkout(root), fork: checkout(fork) };
  const sourceFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], true).split('\0').filter(n => n.endsWith('.bend'));
  for (const name of [...new Set(sourceFiles)]) capture(join(root, name), join(source, name), 'open-dot/' + name);
  for (const name of ['package.json', 'dependencies.lock.json']) capture(join(root, name), join(source, name), 'open-dot/' + name);
  cpSync(join(fork, 'bend2'), compiler, { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/bend2/docs') && !path.split('/').includes('.git') });
  for (const file of files(compiler)) inputs.push({ name: 'f/bend2/' + relative(compiler, file), sha256: fileDigest(file) });
  capture(join(root, 'mobile/icon-512.png'), join(source, 'icon-512.png'), 'open-dot/mobile/icon-512.png');
  capture(join(root, 'mobile/nearling-original.png'), join(source, 'nearling-original.png'), 'open-dot/mobile/nearling-original.png');
  const native = join(stage, 'native');
  mkdirSync(native);
  run('bun', [join(compiler, 'tool.ts'), join(source, 'ios.bend'), '-o', join(native, 'app.c')]);
  const c = readFileSync(join(native, 'app.c'), 'utf8');
  if (c.split('\nint main(int argc, char** argv) {\n').length !== 2) throw new Error('The fork runtime main changed; update the native iOS builder.');
  const targets = target === 'both' ? ['simulator', 'device'] : [target];
  for (const platform of targets) {
    const simulator = platform === 'simulator';
    const sdkName = simulator ? 'iphonesimulator' : 'iphoneos';
    const sdk = run('xcrun', ['--sdk', sdkName, '--show-sdk-path']);
    const sdkVersion = run('xcrun', ['--sdk', sdkName, '--show-sdk-version']);
    const arch = simulator && process.arch === 'x64' ? 'x86_64' : 'arm64';
    const triple = arch + '-apple-ios' + minimum + (simulator ? '-simulator' : '');
    const cc = ['--sdk', sdkName, 'clang', '-target', triple, '-isysroot', sdk];
    const objc = ['-x', 'objective-c', '-fobjc-arc', '-fmodules'];
    const output = join(stage, 'ios-' + platform);
    const objects = join(native, platform);
    const app = join(output, 'Dot.app');
    mkdirSync(app, { recursive: true });
    copyFileSync(join(source, 'nearling-original.png'), join(app, 'nearling-original.png'));
    mkdirSync(objects);
    run('xcrun', [...cc, ...(/^#import /m.test(c) ? [...objc, '-fmodules-ignore-macro=main'] : []), '-std=c11', '-O2', '-DBEND_NATIVE=1', '-DBEND_IOS=1', '-Dmain=bend_main', '-c', join(native, 'app.c'), '-o', join(objects, 'app.o')]);
    for (const name of ['ios_shell', 'paint']) run('xcrun', [...cc, ...objc, '-std=c11', '-O2', '-c', join(compiler, 'std/F/apple', name + '.c'), '-o', join(objects, name + '.o')]);
    run('xcrun', [...cc, join(objects, 'app.o'), join(objects, 'ios_shell.o'), join(objects, 'paint.o'), '-lpthread', '-lm', ...['UIKit', 'Foundation', 'CoreGraphics', 'CoreText', 'CoreImage', 'ImageIO', 'AVFoundation', 'Speech', 'PhotosUI', 'UniformTypeIdentifiers', 'UserNotifications'].flatMap(name => ['-framework', name]), '-o', join(app, 'Dot')]);
    const assets = join(objects, 'Assets.xcassets');
    const icon = join(assets, 'AppIcon.appiconset');
    mkdirSync(icon, { recursive: true });
    writeFileSync(join(assets, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }));
    const images = [20, 29, 40, 60].flatMap(size => [2, 3].map(scale => ({ idiom: 'iphone', size: size + 'x' + size, scale: scale + 'x', filename: 'icon-' + size * scale + '.png' })));
    images.push({ idiom: 'ios-marketing', size: '1024x1024', scale: '1x', filename: 'icon-1024.png' });
    for (const image of images) {
      const pixels = Number(image.size.split('x')[0]) * Number(image.scale.slice(0, -1));
      run('sips', ['-z', String(pixels), String(pixels), join(source, 'icon-512.png'), '--out', join(icon, image.filename)], true);
    }
    writeFileSync(join(icon, 'Contents.json'), JSON.stringify({ images, info: { author: 'xcode', version: 1 } }));
    const iconInfo = join(objects, 'icon-info.plist');
    run('xcrun', ['actool', '--compile', app, '--platform', sdkName, '--minimum-deployment-target', minimum, '--target-device', 'iphone', '--app-icon', 'AppIcon', '--output-partial-info-plist', iconInfo, assets]);
    writeFileSync(join(app, 'Info.plist'), plist({
      ...readPlist(iconInfo), CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Dot', CFBundleExecutable: 'Dot', CFBundleIdentifier: bundle,
      CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'Dot', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: build,
      CFBundleSupportedPlatforms: [simulator ? 'iPhoneSimulator' : 'iPhoneOS'], MinimumOSVersion: minimum, DTPlatformName: sdkName, DTSDKName: sdkName + sdkVersion,
      UIDeviceFamily: [1], UILaunchScreen: {}, UIUserInterfaceStyle: 'Dark', UIApplicationSupportsIndirectInputEvents: true,
      NSCameraUsageDescription: 'Take a photo to send to Near.',
      NSMicrophoneUsageDescription: 'Record voice messages and talk with Near.', NSSpeechRecognitionUsageDescription: 'Understand voice messages and your speech during a call with Near.',
      UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'], BendOrigin: originURL.origin, BendSubmitLabel: 'Enviar',
      BendAPNSEnvironment: signing?.entitlements['aps-environment'] ?? '',
    }));
    let signingMetadata: unknown = { kind: 'ad-hoc-simulator' };
    if (simulator) run('codesign', ['--force', '--timestamp=none', '--sign', '-', app]);
    else {
      const selected = signing!;
      copyFileSync(selected.path, join(app, 'embedded.mobileprovision'));
      const entitlements = join(objects, 'entitlements.plist');
      writeFileSync(entitlements, plist(selected.entitlements));
      run('codesign', ['--force', '--timestamp=none', '--sign', selected.certificate, '--entitlements', entitlements, '--generate-entitlement-der', ...(flags['--keychain'] ? ['--keychain', resolve(flags['--keychain'])] : []), app]);
      signingMetadata = { kind: 'development', certificateSha1: selected.certificate, profileUUID: selected.uuid, profileName: selected.name, expires: selected.expires, registeredDeviceCount: selected.devices, team: selected.team, entitlements: selected.entitlements };
    }
    run('codesign', ['--verify', '--deep', '--strict', app]);
    const appFiles = files(app).map(file => ({ name: relative(app, file), bytes: statSync(file).size, sha256: fileDigest(file) }));
    writeFileSync(join(output, 'build.json'), JSON.stringify({ bendIOS: 1, version, dependencies, builtAt: new Date().toISOString(), target: platform, bundle, minimumOS: minimum,
      sdk: { name: sdkName, version: sdkVersion, architecture: arch }, origin: originURL.origin, compiler: 'PedroAVJ/f Bend2 C', defines: ['BEND_NATIVE=1', 'BEND_IOS=1'], checkoutAtSnapshot: checkouts,
      capturedInputs: inputs.sort((a, b) => a.name.localeCompare(b.name)), generatedCSha256: fileDigest(join(native, 'app.c')), appFiles, signing: signingMetadata,
      verification: { codeSignature: 'verified', installedOnDevice: false, inputTested: false },
    }, null, 2) + '\n');
    if (!simulator) {
      const payload = join(objects, 'Payload');
      mkdirSync(payload);
      cpSync(app, join(payload, 'Dot.app'), { recursive: true });
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', payload, join(output, 'Dot.ipa')]);
      writeFileSync(join(output, 'README.txt'), 'Development-signed Dot iPhone build. Profile expires ' + signing!.expires + '.\nThis IPA is for registered devices in the embedded profile. It has not been installed or tested on a physical iPhone by this build script.\n');
    }
  }
  for (const platform of targets) {
    const output = join(stage, 'ios-' + platform);
    const destination = join(root, 'dist/ios-' + platform);
    const previous = destination + '.previous-' + basename(stage);
    if (existsSync(destination)) {
      const manifest = join(destination, 'build.json');
      if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).bendIOS !== 1) throw new Error('Refusing to replace an unrelated directory: ' + destination);
      renameSync(destination, previous);
    }
    try { renameSync(output, destination); }
    catch (problem) { if (existsSync(previous)) renameSync(previous, destination); throw problem; }
    if (existsSync(previous)) rmSync(previous, { recursive: true });
    console.log('Built ' + join(destination, 'Dot.app') + (platform === 'device' ? ' and Dot.ipa (development signed)' : ''));
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
