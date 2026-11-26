/** ADR-248: the fragment index moved to @engine/assets (packages/assets/src/manifest-index.ts) so the dedicated server
 *  builds the same merged manifest as the client. Re-exported here for existing client imports. */
export { MANIFEST_INDEX, CHAR_ART_V2_FRAGMENT, fragmentBase, applyFragmentFlags, withCharArtFragment, servedManifestIndex, loadMergedManifestWith, loadWearShard, resolveWearShardPaths, CUSTOMIZATION_INDEX_URL, BASE_SHARD_CATEGORY, WEAR_SHARD_CATEGORIES, isWearShardCategory, type ManifestFragmentRef, type ManifestShardRef, type WearShardIO } from "@engine/assets";
