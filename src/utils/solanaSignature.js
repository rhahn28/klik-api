/**
 * Solana Signature Verification Utilities
 *
 * Ed25519 signature verification for OpenClaw wallet agent claims.
 * Validates wallet ownership by verifying signed messages against
 * Solana public keys using tweetnacl.
 */

import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Verify an ed25519 signature from a Solana wallet.
 *
 * @param {string} walletAddress - Base58-encoded Solana public key
 * @param {string} message - The plaintext message that was signed
 * @param {string} signature - Base58-encoded ed25519 signature
 * @returns {boolean} True if the signature is valid
 */
export function verifySolanaSignature(walletAddress, message, signature) {
  try {
    const publicKeyBytes = bs58.decode(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);

    if (publicKeyBytes.length !== 32) {
      return false;
    }

    if (signatureBytes.length !== 64) {
      return false;
    }

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (err) {
    console.error('Signature verification error:', err.message);
    return false;
  }
}

/**
 * Validate that a string is a well-formed Solana public key.
 *
 * @param {string} address - The address string to validate
 * @returns {boolean} True if valid Solana public key
 */
export function isValidSolanaAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return false;
  }

  try {
    const pubkey = new PublicKey(address);
    return pubkey.toBase58() === address;
  } catch (err) {
    return false;
  }
}

/**
 * Generate the exact claim message that the wallet owner must sign.
 *
 * @param {string} agentId - The MongoDB ObjectId string of the agent
 * @param {string} walletAddress - The Solana wallet address
 * @param {string} nonce - 64-character hex nonce
 * @param {string} timestamp - ISO-8601 timestamp
 * @returns {string} The formatted claim message
 */
export function generateClaimMessage(agentId, walletAddress, nonce, timestamp) {
  return [
    `Claim OpenClaw Agent #${agentId} for wallet ${walletAddress}`,
    '',
    `Nonce: ${nonce}`,
    `Timestamp: ${timestamp}`,
    'Domain: klik.cool',
  ].join('\n');
}

/**
 * Generate the exact opt-out message that the wallet owner must sign.
 *
 * @param {string} walletAddress - The Solana wallet address
 * @param {string} nonce - 64-character hex nonce
 * @param {string} timestamp - ISO-8601 timestamp
 * @returns {string} The formatted opt-out message
 */
export function generateOptOutMessage(walletAddress, nonce, timestamp) {
  return [
    `Opt out of OpenClaw for wallet ${walletAddress}`,
    '',
    'I request permanent deletion of my OpenClaw agent and all associated data.',
    '',
    `Nonce: ${nonce}`,
    `Timestamp: ${timestamp}`,
    'Domain: klik.cool',
  ].join('\n');
}
