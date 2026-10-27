import { access } from 'node:fs/promises';
import { nativeRetirementSdkFingerprint } from '../src/host/native-retirement-sdk.ts';
// Tooling only: platform support cannot stand in for the installed SDK identity.
export async function deletionQualification(nativePlatformVerified) {
  let candidate = false;
  try { await access(new URL('../.compatibility-candidate.json', import.meta.url)); candidate = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const qualified = nativePlatformVerified() && await nativeRetirementSdkFingerprint() !== null;
  return { qualified, mode: qualified ? candidate ? 'candidate' : 'supported' : 'unsupported',
    productionDeletionQualified: qualified && !candidate };
}
