/**
 * @file Petites fonctions partagées par les composants.
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combine des classes Tailwind en laissant la dernière gagner.
 *
 * `clsx` gère les conditions, `tailwind-merge` résout les conflits : sans lui,
 * `cn('p-2', 'p-4')` produirait les deux classes et le résultat dépendrait de
 * l'ordre dans la feuille de style.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Horodatage court `14:32:07`, pour la timeline. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false })
}

/** Horodatage complet, pour les infobulles. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

/** Durée lisible entre deux instants ISO ; `null` si la fin manque encore. */
export function duration(from: string, to: string | null): string | null {
  if (!to) return null
  const ms = new Date(to).getTime() - new Date(from).getTime()
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** Temps restant avant un instant ISO, en texte court. `null` si déjà passé. */
export function timeUntil(iso: string, now: number): string | null {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return null
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s`
  return `${Math.ceil(ms / 60_000)} min`
}

/**
 * Montant en dollars, lisible.
 *
 * Quatre décimales en dessous d'un centime : un appel d'agent coûte couramment
 * des fractions de centime, et afficher « 0,00 $ » pour trois centièmes de
 * centime ferait croire que le comptage ne marche pas.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '0 $'
  if (usd >= 0.01) return `${usd.toFixed(2)} $`
  if (usd >= 0.0001) return `${usd.toFixed(4)} $`
  // En dessous, quatre décimales afficheraient « 0,0000 $ » pour un montant non
  // nul, ce qui ressemble à un bogue d'affichage. On montre assez de décimales
  // pour que le chiffre reste vrai.
  return `${usd.toFixed(8).replace(/0+$/, '')} $`
}

/** Nombre de jetons, abrégé au-delà du millier : `12 400` devient `12,4 k`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1).replace('.', ',')} k`
}
