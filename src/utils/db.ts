import { secp256k1PublicKeyToBech32HexHash } from './crypto'
import { KnownError } from './error'
import {
  DbRowProfile,
  DbRowProfilePublicKey,
  DbRowProfilePublicKeyChainPreference,
  Env,
  Profile,
  ProfileWithId,
} from '../types'

/**
 * Transform the DB profile row into a profile.
 */
export const transformProfileRow = (row: DbRowProfile): Profile => ({
  nonce: row.nonce,
  name: row.name,
  nft:
    row.nftChainId && row.nftCollectionAddress && row.nftTokenId
      ? {
          chainId: row.nftChainId,
          collectionAddress: row.nftCollectionAddress,
          tokenId: row.nftTokenId,
        }
      : null,
})

/**
 * Get the profile for a given name.
 */
export const getProfileFromName = async (
  env: Env,
  name: string
): Promise<ProfileWithId | undefined> => {
  const profileRow = await env.DB.prepare(
    'SELECT * FROM profiles WHERE name = ?1'
  )
    .bind(name)
    .first<DbRowProfile>()
  if (!profileRow) {
    return undefined
  }

  return {
    ...transformProfileRow(profileRow),
    id: profileRow.id,
  }
}

/**
 * Get the profile for a given public key.
 */
export const getProfileFromPublicKey = async (
  env: Env,
  publicKey: string
): Promise<ProfileWithId | undefined> => {
  const profileRow = await env.DB.prepare(
    'SELECT * FROM profiles INNER JOIN profile_public_keys ON profiles.id = profile_public_keys.profileId WHERE profile_public_keys.publicKey = ?1'
  )
    .bind(publicKey)
    .first<DbRowProfile>()
  if (!profileRow) {
    return
  }

  return {
    ...transformProfileRow(profileRow),
    id: profileRow.id,
  }
}

/**
 * Get the profile for a given bech32 hash.
 */
export const getProfileFromBech32Hash = async (
  env: Env,
  bech32Hash: string
): Promise<ProfileWithId | undefined> => {
  const profileRow = await env.DB.prepare(
    'SELECT * FROM profiles INNER JOIN profile_public_keys ON profiles.id = profile_public_keys.profileId WHERE profile_public_keys.bech32Hash = ?1'
  )
    .bind(bech32Hash)
    .first<DbRowProfile>()
  if (!profileRow) {
    return
  }

  return {
    ...transformProfileRow(profileRow),
    id: profileRow.id,
  }
}

/**
 * Get the nonce for a given public key. If no profile exists for the public
 * key, return the default nonce of 0.
 */
export const getNonce = async (
  env: Env,
  publicKey: string
): Promise<number> => {
  const profile = await getProfileFromPublicKey(env, publicKey)
  return profile?.nonce || 0
}

/**
 * Get the public key for a given bech32 hash.
 */
export const getPublicKeyForBech32Hash = async (
  env: Env,
  bech32Hash: string
): Promise<string | undefined> => {
  const publicKeyRow = await env.DB.prepare(
    'SELECT publicKey FROM profile_public_keys WHERE bech32Hash = ?1'
  )
    .bind(bech32Hash)
    .first<DbRowProfilePublicKey>()

  return publicKeyRow?.publicKey
}

/**
 * Get top 5 profiles by name prefix and each profiles' public key for a given
 * chain.
 */
export const getProfilesWithNamePrefix = async (
  env: Env,
  namePrefix: string,
  chainId: string
): Promise<
  {
    publicKey: string
    bech32Hash: string
    profileId: number
    profile: Profile
  }[]
> => {
  const rows =
    (
      await env.DB.prepare(
        'SELECT * FROM profiles INNER JOIN profile_public_key_chain_preferences ON profiles.id = profile_public_key_chain_preferences.profileId INNER JOIN profile_public_keys ON profile_public_key_chain_preferences.profilePublicKeyId = profile_public_keys.id WHERE profiles.name LIKE ?1 AND profile_public_key_chain_preferences.chainId = ?2 ORDER BY name ASC LIMIT 5'
      )
        .bind(namePrefix + '%', chainId)
        .all<DbRowProfile & DbRowProfilePublicKey>()
    ).results ?? []

  return rows.flatMap((row) =>
    row
      ? {
          publicKey: row.publicKey,
          bech32Hash: row.bech32Hash,
          profileId: row.id,
          profile: transformProfileRow(row),
        }
      : []
  )
}

/**
 * Get the public key for a profile on a given chain.
 */
export const getPreferredProfilePublicKey = async (
  env: Env,
  profileId: number,
  chainId: string
): Promise<Pick<DbRowProfilePublicKey, 'publicKey' | 'bech32Hash'> | null> =>
  await env.DB.prepare(
    'SELECT profile_public_keys.publicKey AS publicKey, profile_public_keys.bech32Hash AS bech32Hash FROM profile_public_keys INNER JOIN profile_public_key_chain_preferences ON profile_public_keys.id = profile_public_key_chain_preferences.profilePublicKeyId WHERE profile_public_key_chain_preferences.profileId = ?1 AND profile_public_key_chain_preferences.chainId = ?2'
  )
    .bind(profileId, chainId)
    .first<Pick<DbRowProfilePublicKey, 'publicKey' | 'bech32Hash'>>()

/**
 * Get the public keys for a profile.
 */
export const getProfilePublicKeys = async (
  env: Env,
  profileId: number
): Promise<DbRowProfilePublicKey[]> =>
  (
    await env.DB.prepare(
      'SELECT * FROM profile_public_keys WHERE profileId = ?1'
    )
      .bind(profileId)
      .all<DbRowProfilePublicKey>()
  ).results

/**
 * Get the public key for each chain preference set on a profile.
 */
export const getProfilePublicKeyPerChain = async (
  env: Env,
  profileId: number
): Promise<
  {
    chainId: string
    publicKey: string
  }[]
> =>
  (
    await env.DB.prepare(
      'SELECT profile_public_key_chain_preferences.chainId AS chainId, profile_public_keys.publicKey AS publicKey FROM profile_public_key_chain_preferences INNER JOIN profile_public_keys ON profile_public_key_chain_preferences.profilePublicKeyId = profile_public_keys.id WHERE profile_public_key_chain_preferences.profileId = ?1'
    )
      .bind(profileId)
      .all<
        Pick<DbRowProfilePublicKeyChainPreference, 'chainId'> &
          Pick<DbRowProfilePublicKey, 'publicKey'>
      >()
  ).results

/**
 * Save profile.
 */
export const saveProfile = async (
  env: Env,
  publicKey: string,
  profile: Profile,
  // Optionally set preferences for the given chains on profile creation.
  chainIds?: string[]
) => {
  const existingProfile = await getProfileFromPublicKey(env, publicKey)
  // If profile exists, update.
  if (existingProfile) {
    await env.DB.prepare(
      'UPDATE profiles SET nonce = ?1, name = ?2, nftChainId = ?3, nftCollectionAddress = ?4, nftTokenId = ?5, updatedAt = CURRENT_TIMESTAMP WHERE id = ?6'
    )
      .bind(
        profile.nonce,
        profile.name,
        profile.nft?.chainId ?? null,
        profile.nft?.collectionAddress ?? null,
        profile.nft?.tokenId ?? null,
        existingProfile.id
      )
      .run()
  }
  // Otherwise, create.
  else {
    const profileRow = await env.DB.prepare(
      'INSERT INTO profiles (nonce, name, nftChainId, nftCollectionAddress, nftTokenId) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
    )
      .bind(
        profile.nonce,
        profile.name,
        profile.nft?.chainId ?? null,
        profile.nft?.collectionAddress ?? null,
        profile.nft?.tokenId ?? null
      )
      .first<Pick<DbRowProfile, 'id'>>()
    if (!profileRow) {
      throw new KnownError(500, 'Failed to save profile.')
    }

    const profilePublicKeyRow = await env.DB.prepare(
      'INSERT INTO profile_public_keys (profileId, publicKey, bech32Hash) VALUES (?1, ?2, ?3) RETURNING *'
    )
      .bind(
        profileRow.id,
        publicKey,
        secp256k1PublicKeyToBech32HexHash(publicKey)
      )
      .first<DbRowProfilePublicKey>()
    if (!profilePublicKeyRow) {
      throw new KnownError(500, 'Failed to save profile public key.')
    }

    // Set chain preferences for this public key if specified.
    if (chainIds) {
      await setProfileChainPreferences(
        env,
        profileRow.id,
        profilePublicKeyRow.id,
        chainIds
      )
    }
  }
}

/**
 * Increment profile nonce.
 */
export const incrementProfileNonce = async (
  env: Env,
  profileId: number
): Promise<void> => {
  await env.DB.prepare(
    'UPDATE profiles SET nonce = nonce + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?1'
  )
    .bind(profileId)
    .run()
}

/**
 * Add public key to profile and/or optionally update the profile's preferences
 * for the given chains to this public key.
 */
export const addProfilePublicKey = async (
  env: Env,
  profileId: number,
  publicKey: string,
  chainIds?: string[]
) => {
  // Get profile this public key is currently attached to.
  const currentProfile = await getProfileFromPublicKey(env, publicKey)

  // If attached to a different profile already, remove it.
  if (currentProfile && currentProfile.id !== profileId) {
    // Remove the public key from its current profile.
    await removeProfilePublicKeys(env, currentProfile.id, [publicKey])
  }

  const profilePublicKeyRow =
    // If not attached to the current profile, attach it.
    !currentProfile || currentProfile.id !== profileId
      ? await env.DB.prepare(
          'INSERT INTO profile_public_keys (profileId, publicKey, bech32Hash) VALUES (?1, ?2, ?3) RETURNING id'
        )
          .bind(
            profileId,
            publicKey,
            secp256k1PublicKeyToBech32HexHash(publicKey)
          )
          .first<Pick<DbRowProfilePublicKey, 'id'>>()
      : // Otherwise just find the existing public key.
        await env.DB.prepare(
          'SELECT id FROM profile_public_keys WHERE publicKey = ?1'
        )
          .bind(publicKey)
          .first<Pick<DbRowProfilePublicKey, 'id'>>()
  if (!profilePublicKeyRow) {
    throw new KnownError(500, 'Failed to save or retrieve profile public key.')
  }

  // Set chain preferences for this public key if specified.
  if (chainIds) {
    await setProfileChainPreferences(
      env,
      profileId,
      profilePublicKeyRow.id,
      chainIds
    )
  }
}

/**
 * Set chain preferences for a given public key.
 */
const setProfileChainPreferences = async (
  env: Env,
  profileId: number,
  publicKeyRowId: number,
  chainIds: string[]
): Promise<void> => {
  // Insert or update chain preferences.
  await env.DB.batch(
    chainIds.map((chainId) =>
      env.DB.prepare(
        'INSERT INTO profile_public_key_chain_preferences (profileId, chainId, profilePublicKeyId) VALUES (?1, ?2, ?3) ON CONFLICT (profileId, chainId) DO UPDATE SET profilePublicKeyId = ?3, updatedAt = CURRENT_TIMESTAMP WHERE profileId = ?1 AND chainId = ?2'
      ).bind(profileId, chainId, publicKeyRowId)
    )
  )
}

/**
 * Remove public keys from profile. If all public keys are removed, delete the
 * entire profile.
 */
export const removeProfilePublicKeys = async (
  env: Env,
  profileId: number,
  publicKeys: string[]
) => {
  // Get all public keys attached to the profile.
  const publicKeyRows = await getProfilePublicKeys(env, profileId)

  // If removing all public keys, delete the entire profile, since no public
  // keys will have access to it anymore and thus we need to free up the name.
  if (publicKeyRows.every((row) => publicKeys.includes(row.publicKey))) {
    // Delete cascades to public keys and chain preferences.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?1')
      .bind(profileId)
      .run()
    return
  }

  // Otherwise remove just these public keys.
  const publicKeyRowsToDelete = publicKeys.flatMap(
    (publicKey) =>
      publicKeyRows.find((row) => row.publicKey === publicKey) || []
  )
  await env.DB.batch(
    publicKeyRowsToDelete.map(({ id }) =>
      // Delete cascades to chain preferences.
      env.DB.prepare('DELETE FROM profile_public_keys WHERE id = ?1').bind(id)
    )
  )
}
