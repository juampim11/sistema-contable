export * from './parseo-ar.ts';
export * from './esquema.ts';
export * from './hash.ts';
export * from './texto-pdf.ts';
export * from './verificacion/invariantes.ts';
export * from './verificacion/mutaciones.ts';
export * from './seed/extracto-sintetico.ts';
export * from './resolver-cuenta.ts';
export * from './glosa.ts';
export * from './contraparte.ts';
export * from './version-extraccion.ts';
export * from './contraparte-adaptadores.ts';
export * from './seed/texto-extracto-sintetico.ts';
export * from './adaptadores/contrato.ts';
export * from './adaptadores/registro.ts';
export * from './adaptadores/toolkit.ts';
export * from './persistir.ts';
export * from './planilla/exportar-planilla.ts';
export * from './reproceso/recapturar-conceptos.ts';
export * from './reproceso/backfill-contraparte.ts';
export * from './reproceso/reclasificar-contraparte.ts';
export * from './reproceso/detectar-lotes-desactualizados.ts';
export * from './plan-cuentas/parser.ts';
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
  type SalidaGalicia,
} from './adaptadores/galicia.ts';
export {
  adaptadorMacro,
  CAPACIDADES_MACRO,
  leerMacro,
  reconoceMacro,
  type SalidaMacro,
} from './adaptadores/macro.ts';
// A1 (`docs/diseno/10-deuda-declarada.md` §2.4): los tres adaptadores usan `EntradaDeAdaptador`/
// `SalidaDeAdaptador` del contrato — directo (Santander), como alias (Galicia) o como intersection
// (Macro, que promete más). `SalidaGalicia`/`SalidaMacro` siguen exportándose acá a propósito: son la
// fachada de cada adaptador, no un tipo paralelo. Ver `registro.ts`.
export {
  adaptadorSantander,
  CAPACIDADES_SANTANDER,
  leerSantander,
  reconoceSantander,
} from './adaptadores/santander.ts';
export {
  adaptadorBancor,
  CAPACIDADES_BANCOR,
  leerBancor,
  reconoceBancor,
  verificarTotalesBancor,
  type SalidaBancor,
  type VerificacionTotalBancor,
} from './adaptadores/bancor.ts';
export {
  adaptadorNacion,
  CAPACIDADES_NACION,
  leerNacion,
  reconoceNacion,
  type SalidaNacion,
} from './adaptadores/nacion.ts';
export {
  adaptadorIcbc,
  CAPACIDADES_ICBC,
  leerIcbc,
  reconoceICBC,
  type SalidaIcbc,
} from './adaptadores/icbc.ts';
