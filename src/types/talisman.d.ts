/** Hand-written types for talisman's CommonJS subpath modules. */
declare module "talisman/phonetics/double-metaphone.js" {
  const doubleMetaphone: (word: string) => [string, string];
  export default doubleMetaphone;
}
declare module "talisman/phonetics/metaphone.js" {
  const metaphone: (word: string) => string;
  export default metaphone;
}
declare module "talisman/phonetics/french/phonex.js" {
  const phonex: (word: string) => string;
  export default phonex;
}
declare module "talisman/phonetics/french/sonnex.js" {
  const sonnex: (word: string) => string;
  export default sonnex;
}
declare module "talisman/phonetics/french/fonem.js" {
  const fonem: (word: string) => string;
  export default fonem;
}
declare module "talisman/metrics/jaro-winkler.js" {
  const jaroWinkler: (a: string, b: string) => number;
  export default jaroWinkler;
}
declare module "talisman/metrics/levenshtein.js" {
  const levenshtein: (a: string, b: string) => number;
  export default levenshtein;
}
