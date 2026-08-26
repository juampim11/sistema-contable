# 01 · Entornos (producción y testing) — guía neutral de infraestructura

> **Plantilla.** Reemplazá los marcadores `<ASI>` por los valores de tu proyecto. Esta guía es
> **neutral respecto del proveedor**: usa **`<PROVEEDOR_HOSTING>`** (ej. Vercel, Netlify, AWS
> Amplify, Cloud Run) y **`<PROVEEDOR_BD>`** (ej. Supabase, Neon, PlanetScale, AWS RDS) como piezas
> **intercambiables**. Los principios valen igual con cualquiera; los ejemplos concretos van entre
> paréntesis.

---

## 0.bis 🔴 ESTADO HOY: un solo entorno, y es una DEMO

> **Decisión del titular, 2026-08-10.** Lo de abajo es la guía a la que se va; **esto es lo que hay**, y
> mientras diga esto, manda esto.

**Hoy existe un solo entorno: la máquina de desarrollo.** No hay prod, ni staging, ni testing desplegado.
Lo que hay es una base local en Docker (`sistema_contable`, la de los tests) y otra base local separada
(`sistema_contable_piloto`, con material real). **Eso es a propósito y no es deuda oculta: es una demo.**

**El compromiso que esto lleva, y que hay que cumplir:**

1. **Lo que está cargado hoy NO viaja a producción.** Cuando el producto pase a prod, **todo lo cargado se
   borra**, o —preferido— **se levanta un entorno limpio desde cero**. Producción arranca **vacía** y procesa
   la información **desde cero**, con altas hechas en producción.
2. **Ninguna base de la demo se "promueve".** No se hace `pg_dump` del piloto a prod, no se migra el tenant,
   no se copia el bucket. El camino de la demo a prod es **esquema + código**, nunca datos.
3. **Los identificadores de la demo no sobreviven.** Los `uuid` de cliente, los lotes, las claves de objeto
   y el `pepper` del piloto son de la demo. En prod se genera un pepper nuevo — y eso **por sí solo** vuelve
   irreproducibles los `cbu_hmac` de la demo, que es exactamente lo que se quiere.
4. **Prod-staging-testing-dev llega después.** Está bien que hoy no exista; lo que no está bien es que nadie
   lo haya escrito. Queda escrito: es la etapa siguiente a la demo, y el resto de este documento es el
   destino.

**Por qué importa que esté acá y no en la cabeza de alguien:** el día que el producto funcione, el atajo
tentador va a ser *"ya está todo cargado, subamos esta base"*. Esa base tiene material real de **varios
titulares** que se cargó bajo una excepción de construcción (`docs/seguridad/registro-excepciones.md`, E-1),
con identidades provisorias y sin las altas hechas por nadie del estudio. Promoverla convertiría una
excepción temporal en el estado permanente de producción, y ya nadie podría decir de dónde salió cada fila.

**Y el corolario que cierra E-1:** la columna "se destruye" de esa excepción decía *"sin fecha definida"*.
Ahora tiene criterio, aunque no tenga fecha: **el material y todo lo derivado de él se destruyen al pasar a
producción**, porque producción arranca de cero.

---

## 0. Por qué dos entornos (el problema que evita)

Con **un solo mundo** (una base y un hosting), desarrollar y probar en tu máquina se conecta a la
**base de producción**: cada prueba consume recursos reales y puede corromper datos reales. La
solución de base: **dos entornos separados**.

```
   Rama de producción  ──►  <PROVEEDOR_HOSTING> · Producción  ──►  <PROVEEDOR_BD> PROD   (datos reales)
   Ramas de trabajo    ──►  <PROVEEDOR_HOSTING> · Preview      ──►  <PROVEEDOR_BD> TESTING (datos de prueba)
   y pruebas locales
```

**Principio 1 — Aislamiento total:** producción nunca recibe tráfico de desarrollo. Testing usa
**sus propias credenciales**, jamás las de producción.

---

## 1. Mapa de entornos

| Origen | Hosting despliega en | Base de datos | Cuándo |
|---|---|---|---|
| Rama **`<RAMA_PRODUCCION>`** (por defecto `main`) | **Production** | **`<PROVEEDOR_BD>` PROD** (`<REF_PROYECTO_PROD>`) | en cada push/merge |
| **Cualquier otra rama** de trabajo | **Preview** (URL por rama) | **`<PROVEEDOR_BD>` TESTING** (`<REF_PROYECTO_TESTING>`) | en cada push a esa rama |
| Tu máquina (`.env.local`) | local | **`<PROVEEDOR_BD>` TESTING** | siempre |

> **Opcional — URL de staging estable:** si querés *una* dirección fija para mostrar/probar (en vez
> de una URL distinta por rama), usá una rama fija `staging` o `develop` apuntada al entorno de
> testing. No es obligatorio; es comodidad.

---

## 2. Variables de entorno (el puente entre deploy y base)

**Principio 2 — Cada variable existe dos veces:** una en *Production* (valor de prod) y otra en
*Preview/Development* (valor de testing). Al **agregar una variable nueva**, cargala en **los dos**
scopes del hosting **y** en tu `.env.local`. Si falta en alguno, ese entorno rompe.

| Variable (ejemplo) | Producción | Testing / Preview | `.env.local` | ¿Secreta? |
|---|---|---|---|---|
| `<VAR_URL_BD>` | URL de PROD (`<URL_BASE_DATOS_PROD>`) | URL de TESTING (`<URL_BASE_DATOS_TESTING>`) | URL de TESTING | No (pública) |
| `<VAR_CLAVE_PUBLICA_BD>` | clave pública PROD | clave pública TESTING | clave pública TESTING | No |
| `<VAR_CLAVE_SECRETA_BD>` | clave secreta PROD | clave secreta TESTING | clave secreta TESTING | 🔴 **Sí** |
| `<VAR_SECRET_CRON>` | valor A | valor B **distinto** | valor B | 🔴 Sí |
| `<VAR_INTEGRACIONES_*>` (email, pagos, OCR…) | credenciales reales | de prueba / modo off | de prueba / off | 🔴 Sí |
| `<VAR_CONFIG_NO_SECRETA>` (timezone, flags) | igual en ambos | igual | igual | No |

**Reglas de secretos:**
1. Ningún secreto en el repo ni por chat/mail: se cargan directo en el panel del hosting y en
   `.env.local` (que está gitigneado).
2. La **clave secreta / de servicio** de la base **nunca** con prefijo público ni en el navegador.
   Si se filtra, se rota de inmediato.
3. Usá un **secreto de cron distinto** por entorno, para que un disparo de un entorno no sirva contra
   el otro.
4. Las variables "públicas" que se **hornean en el build** (ej. `NEXT_PUBLIC_*` en Next, `VITE_*` en
   Vite) quedan fijas al momento del build → si cambian, hay que **rebuildear**.

---

## 3. Preparar el entorno de testing (una vez)

**Principio 3 — Testing es un clon estructural de prod, con datos sintéticos:**

1. **Crear** el proyecto/base de testing en `<PROVEEDOR_BD>` (misma región que prod si se puede).
   Generar una **contraseña distinta** a la de prod.
2. **Aplicar el esquema:** correr todas las migraciones sobre testing (`<COMANDO_MIGRACIONES>`).
3. **Cargar catálogo base** (datos de configuración, no personales).
4. **Cargar datos de prueba sintéticos** — **nunca** el padrón real con datos personales (ver §5).
5. **Cargar las variables** de testing en el hosting (scope Preview) y en `.env.local`.

> **Límites del plan gratis (verificar los vigentes del proveedor elegido):** muchos free tiers
> permiten **2 proyectos activos** por organización (prod + testing llegan justo), y **pausan** un
> proyecto sin uso por un tiempo. Presupuestar ambos entornos contra el mismo plan.

---

## 3.bis Binarios de sistema requeridos (fuera de `pnpm`)

No todo se instala con `pnpm install`. Lo que sigue tiene que estar en el `PATH` de la máquina (local o
CI) antes de correr el código que depende de eso — `pnpm verificar` no lo detecta por sí solo.

| Binario | Para qué | Build requerida, y por qué | Instalación (Windows/Chocolatey) |
|---|---|---|---|
| `pdftotext` | `packages/ingesta/src/fci-santander/extraer-posiciones.ts` — fuente auxiliar de la SECUENCIA de etiquetas (ver `docs/diseno/19-fci-santander-extractor-hibrido.md`) | **Poppler**, no xpdf ni cualquier binario que resuelva ese nombre. Confirmado en esta sesión (2026-08-25): xpdf 4.00 y Poppler producen resultados estructuralmente DISTINTOS para el mismo PDF real con `-layout` — el diseño del extractor se validó contra Poppler 24.02.0. Verificar la build con `pdftotext -v` antes de asumir que "ya está instalado" alcanza. | `choco install poppler -y` (shell elevada) |

🔴 **Sin chequeo automático todavía.** Si este binario llega a ser una dependencia real de producción
(no solo de un extractor preliminar), agregar una verificación de arranque (mismo espíritu que el guard
de `conUsuario()` contra `BYPASSRLS`) que confirme la build correcta antes de correr, en vez de fallar
tarde con un resultado silenciosamente distinto.

---

## 4. Aplicar cambios de base (migraciones) — el paso que no es automático

**Principio 4 — El hosting despliega CÓDIGO, no ESQUEMA.** Código y base se coordinan a mano:

> **Regla de oro:** para una migración **aditiva y compatible hacia atrás** (agregar tabla/columna/
> índice/vista sin romper lo viejo), aplicala a **prod ANTES** de mergear el código. El orden inverso
> deja una ventana en la que prod corre contra un esquema que todavía no existe → error.

Flujo genérico (adaptá `<COMANDO_MIGRACIONES>` a tu herramienta):

```
# 1) VERIFICAR a qué entorno apunta la CLI (el error más caro es aplicar al equivocado)
<COMANDO_VER_ENTORNO_ACTIVO>

# 2) Aplicar a TESTING (durante el desarrollo)
<COMANDO_VINCULAR_TESTING> && <COMANDO_MIGRACIONES>

# 3) Aplicar a PROD (recién en el pasaje a producción, con aprobación)
<COMANDO_VINCULAR_PROD> && <COMANDO_MIGRACIONES>

# 4) Regenerar tipos/artefactos si cambió el esquema
<COMANDO_REGENERAR_TIPOS>
```

**Reglas duras:** nunca editar una migración ya aplicada; crear una nueva con prefijo incremental;
regenerar tipos después. **Cambios destructivos** (renombrar/eliminar columna en uso): patrón
**expand/contract** en dos pasos, nunca en una sola migración.

**Caveat de testing compartido:** si hay **una sola** base de testing para todas las ramas de
preview, dos ramas con migraciones distintas se pisan. Con equipo chico, alcanza con tener **una
feature con migración a la vez** en testing.

---

## 5. Qué NO hacer (seguridad — leer antes de tocar)

1. **Nunca apuntar testing (ni `.env.local`) a las credenciales de PRODUCCIÓN.**
2. **La clave de servicio jamás en el navegador** ni con prefijo público. Solo variable server.
3. **No cargar datos personales reales en testing.** Testing usa datos **sintéticos**. La PII real
   solo vive en producción.
4. **Antes de cada migración, confirmar a qué entorno apunta la CLI.** Aplicar al equivocado es el
   error más caro.
5. **Secretos distintos por entorno** (cron, tokens de integración).
6. **Ningún secreto por chat, mail o captura.**

---

## 6. Rollback (principio de seguridad)

- **Código:** revertir el merge en la rama de producción (el hosting redepliega el estado anterior) o
  promover un deploy previo desde el panel.
- **Base:** **nunca** se "desaplica" una migración editándola. Se crea una **migración nueva** que
  revierte el efecto (forward-fix). Por eso las migraciones aditivas/compatibles son preferibles.
- **Datos:** si el plan **no** tiene backups automáticos, **presupuestar backups manuales** antes de
  cada release — otra razón para que prod solo reciba cambios ya probados en testing.

---

_Plantilla del template `<NOMBRE_PROYECTO>`. Ver `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
`03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas)._
