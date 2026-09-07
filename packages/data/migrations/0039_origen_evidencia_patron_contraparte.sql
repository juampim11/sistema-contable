-- =============================================================================
-- 0039_origen_evidencia_patron_contraparte.sql — hermana de patron_contraparte_estado (0038):
-- persiste CUÁL glosa (concepto_banco vs descripcion) produjo el match/multiples_patrones, ahora
-- que resolverEvidenciaDeContraparte() (packages/contabilidad/src/nucleo/contraparte.ts) hace
-- fallback secuencial entre las dos (convocatoria 2026-09-06, corpus real de Bracci: el matcher
-- daba 0 matches en 1428 movimientos porque concepto_banco, para Galicia/Santander, es un segmento
-- geométrico que nunca llega al nombre del proveedor — medido: 79/79 apariciones reales de 7
-- patrones cargados vivían en descripcion, 0/79 en concepto_banco; Bancor/ICBC/Nación ni capturan
-- concepto_banco).
--
-- Convocatoria formal (CLAUDE.md §3.1): dba-data + security-engineer + seguridad-datos-financieros,
-- primero sobre el mecanismo general (fallback secuencial, nunca merge; el dato nuevo entra como
-- parámetro explícito, nunca ensancha EvidenciaDeMovimiento/el tipo compartido del motor), después
-- sobre este DDL concreto. Sin renglones de ADR-0001 §5: no es tabla nueva, es una columna sobre
-- una tabla que ya tiene RLS forzada, trigger y FKs (0021/0038).
--
-- Verificado EN VIVO antes de escribir este archivo (2026-09-06, local): 0 filas totales en
-- reconocimiento_contrapartida, 0 con patron_contraparte_estado in ('match','multiples_patrones')
-- — el ADD CONSTRAINT de abajo no tiene ninguna fila existente que pueda rechazar. Reverificar el
-- conteo si pasa tiempo antes de aplicar, mismo criterio que 0038 (b).
--
-- 🔴 Hallazgo de secuenciación (dba-data + security-engineer + seguridad-datos-financieros, los
-- tres por separado, mismo veredicto): esta migración y el código del escritor
-- (packages/data/src/contabilidad/escrituras.ts, apps/cli/src/reconocer-lote.ts) tienen que
-- desplegarse en el MISMO release — aplicada sola, el próximo INSERT de capa C con
-- patron_contraparte_estado = 'match'/'multiples_patrones' viola
-- contrapartida_patron_origen_coherencia_chk (23514), porque el escritor todavía mandaría
-- patron_contraparte_origen = NULL. Mismo patrón exacto que el punto (c) de 0038.
--
-- SE APLICA CON EL DUEÑO DEL ESQUEMA. NUNCA EDITAR UNA VEZ APLICADA.
-- =============================================================================

begin;

alter table reconocimiento_contrapartida
  add column patron_contraparte_origen text;

-- Dominio cerrado (nullable). SIN "is null or": un CHECK que evalúa a NULL SATISFACE el constraint
-- igual que TRUE (semántica estándar de Postgres, ya documentada en este repo en 0021) — agregar
-- "is null or" no cambia el comportamiento y sí saca al check de la forma `col = ANY (ARRAY[…])`
-- que catalogo.test.ts usa para detectar dominios cerrados automáticamente. Con "is null or" este
-- check quedaría invisible para ese barrido — mismo punto ciego, hoy sin test, que
-- regla_imputacion_concepto_chk (0030): no se perpetúa acá (hallazgo dba-data).
alter table reconocimiento_contrapartida add constraint contrapartida_patron_origen_chk
  check (patron_contraparte_origen in ('concepto_banco', 'descripcion'));

-- Coherencia con patron_contraparte_estado: origen SOLO cuando hubo algo que atribuir. Misma forma
-- que las coherencias ya usadas en 0021/0038 — a propósito SIN forma de dominio cerrado
-- (catalogo.test.ts lo documenta y excluye): expresa una relación entre dos columnas, no un dominio.
-- Cubre las 4 combinaciones (estado x origen nulo/no nulo) sin fuga: ambos operandos de la igualdad
-- son NOT NULL por construcción (patron_contraparte_estado es NOT NULL desde 0038, IS NOT NULL
-- nunca da NULL), así que la comparación nunca degenera en UNKNOWN (verificado security-engineer).
alter table reconocimiento_contrapartida add constraint contrapartida_patron_origen_coherencia_chk
  check ((patron_contraparte_estado in ('match', 'multiples_patrones'))
         = (patron_contraparte_origen is not null));

-- SELECT ya cubierto por el grant de tabla de 0021 (`grant select on reconocimiento_contrapartida
-- to app_request`) — no se repite. app_job NO recibe grant: esta tabla se escribe solo vía
-- conUsuario/app_request (reconocer-lote.ts), nunca vía conJob (mismo criterio que 0038).
grant insert (patron_contraparte_origen) on reconocimiento_contrapartida to app_request;

comment on column reconocimiento_contrapartida.patron_contraparte_origen is
  'N2. Uno de los 2 valores de OrigenEvidenciaContraparte (packages/contabilidad/src/nucleo/'
  'contraparte.ts), lista ORIGENES_EVIDENCIA_CONTRAPARTE. Cuál glosa (concepto_banco vs '
  'descripcion) produjo el match/multiples_patrones — resolverEvidenciaDeContraparte() intenta '
  'concepto_banco primero y sólo reintenta con descripcion si da sin_match (fallback SECUENCIAL, '
  'nunca merge). NULL cuando patron_contraparte_estado es no_aplica|sin_match: no hay nada que '
  'atribuir (contrapartida_patron_origen_coherencia_chk lo fuerza). Mismo tier que '
  'patron_contraparte_estado: metadata de PROCESO sobre la MISMA evidencia (de qué campo salió el '
  'match), no un dato nuevo del tercero.';

comment on constraint contrapartida_patron_origen_chk on reconocimiento_contrapartida is
  'Dominio cerrado (nullable). Lista IDÉNTICA a ORIGENES_EVIDENCIA_CONTRAPARTE '
  '(packages/contabilidad/src/nucleo/contraparte.ts). NULL pasa por semántica estándar de CHECK '
  '(NULL no es FALSE); no lleva "is null or" a propósito, para quedar en la forma que '
  'catalogo.test.ts detecta automáticamente.';

comment on constraint contrapartida_patron_origen_coherencia_chk on reconocimiento_contrapartida is
  'Coherencia con patron_contraparte_estado: origen se escribe si y sólo si el estado es match o '
  'multiples_patrones. No es dominio cerrado (catalogo.test.ts lo excluye a propósito, mismo '
  'criterio que otras coherencias de este esquema).';

commit;
