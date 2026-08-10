export * from './parseo-ar.ts';
export * from './esquema.ts';
export * from './hash.ts';
export * from './texto-pdf.ts';
export * from './verificacion/invariantes.ts';
export * from './verificacion/mutaciones.ts';
export * from './seed/extracto-sintetico.ts';
export * from './resolver-cuenta.ts';
export * from './glosa.ts';
export * from './seed/texto-extracto-sintetico.ts';
export * from './adaptadores/contrato.ts';
export * from './adaptadores/registro.ts';
export * from './adaptadores/toolkit.ts';
export * from './persistir.ts';
/**
 * 🔴 **Los adaptadores se re-exportan por NOMBRE, nunca con `export *`.**
 *
 * Cada adaptador declara `BANCO_CODIGO` y `VERSION`, así que dos `export *` chocan en esos dos nombres —
 * y ESM no falla: **omite el símbolo ambiguo en silencio**. El resultado sería que `BANCO_CODIGO`
 * desaparece del índice del paquete sin un solo error de tipos, y el que lo importe recibe `undefined`.
 *
 * Con ocho bancos en el roster esto pasaba en el segundo. Lo encontró el adaptador de Macro al integrarse.
 */
export {
  adaptadorGalicia,
  CAPACIDADES_GALICIA,
  leerGalicia,
  reconoceGalicia,
  type EntradaGalicia,
  type SalidaGalicia,
} from './adaptadores/galicia.ts';
export {
  adaptadorMacro,
  CAPACIDADES_MACRO,
  leerMacro,
  reconoceMacro,
  type EntradaMacro,
  type SalidaMacro,
} from './adaptadores/macro.ts';
// Santander no declara tipos propios de entrada/salida: usa `SalidaDeAdaptador` del contrato, que es
// hacia dónde converge el registro. Galicia y Macro todavía tienen los suyos, de cuando el contrato no
// estaba decidido.
export {
  adaptadorSantander,
  CAPACIDADES_SANTANDER,
  leerSantander,
  reconoceSantander,
} from './adaptadores/santander.ts';
