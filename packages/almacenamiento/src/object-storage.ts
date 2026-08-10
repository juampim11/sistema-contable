/**
 * `ObjectStorage` — la abstracción de almacenamiento de ADR-0000 §3.3.
 *
 * El dominio no habla S3. Habla de guardar y recuperar el archivo de un cliente. Esta interfaz es la
 * frontera: adentro está `@aws-sdk/client-s3` apuntado por configuración, afuera nadie sabe qué proveedor
 * hay. Cambiar de MinIO local a S3, a Cloud Storage por su API XML o a Supabase Storage es cambiar
 * variables de entorno.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

export interface ObjectStorage {
  guardar(clave: string, cuerpo: Buffer, contentType: string): Promise<void>;
  obtener(clave: string): Promise<Buffer>;
  urlFirmada(clave: string, expiraEnSegundos: number): Promise<string>;
  eliminar(clave: string): Promise<void>;
}

/**
 * ## Dos clientes, no uno
 *
 * El compose crea **dos cuentas de servicio** en MinIO: una de lectura y una de escritura. Este módulo las
 * usa como tales, y no es simetría decorativa: el proceso que atiende pedidos y emite URL de descarga no
 * necesita poder escribir, y el que ingesta no necesita poder leer objetos de otros lotes. Con una sola
 * credencial, un RCE en cualquiera de los dos caminos tiene los dos permisos.
 *
 * En AWS son dos políticas de IAM; en GCP, dos claves HMAC. El código no cambia.
 */
export type ConfigAlmacenamiento = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly lectura: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly escritura: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** MinIO necesita path-style; S3 real usa virtual-hosted. Es config, no un `if` en el código. */
  readonly forcePathStyle: boolean;
};

const esquemaConfig = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1),
  bucket: z.string().min(1),
  lectura: z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  escritura: z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  forcePathStyle: z.boolean(),
});

/**
 * Lee la configuración del entorno y **falla ruidoso si falta algo**.
 *
 * Sin esto, una variable ausente se convierte en una credencial vacía, el SDK falla con un error de
 * autenticación y el diagnóstico apunta al proveedor en vez de al `.env`.
 */
export function configDelEntorno(): ConfigAlmacenamiento {
  const leer = (nombre: string): string => {
    const v = process.env[nombre];
    if (!v) {
      throw new Error(
        `Falta ${nombre}. El almacenamiento necesita la configuración de ADR-0000 §3.3:\n` +
          '  cp .env.example .env && pnpm db:up',
      );
    }
    return v;
  };

  return esquemaConfig.parse({
    endpoint: leer('S3_ENDPOINT'),
    region: process.env['S3_REGION'] ?? 'us-east-1',
    bucket: leer('S3_BUCKET'),
    lectura: {
      accessKeyId: leer('S3_LECTURA_ACCESS_KEY_ID'),
      secretAccessKey: leer('S3_LECTURA_SECRET_ACCESS_KEY'),
    },
    escritura: {
      accessKeyId: leer('S3_ESCRITURA_ACCESS_KEY_ID'),
      secretAccessKey: leer('S3_ESCRITURA_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: (process.env['S3_FORCE_PATH_STYLE'] ?? 'true') === 'true',
  });
}

function cliente(config: ConfigAlmacenamiento, credencial: 'lectura' | 'escritura'): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: config[credencial],
  });
}

export function crearObjectStorage(config: ConfigAlmacenamiento): ObjectStorage {
  const paraLeer = cliente(config, 'lectura');
  const paraEscribir = cliente(config, 'escritura');
  const Bucket = config.bucket;

  return {
    async guardar(clave, cuerpo, contentType) {
      await paraEscribir.send(
        new PutObjectCommand({ Bucket, Key: clave, Body: cuerpo, ContentType: contentType }),
      );
    },

    async obtener(clave) {
      const r = await paraLeer.send(new GetObjectCommand({ Bucket, Key: clave }));
      if (!r.Body) throw new Error(`El objeto ${clave} vino sin cuerpo.`);
      return Buffer.from(await r.Body.transformToByteArray());
    },

    async urlFirmada(clave, expiraEnSegundos) {
      // Se firma con la credencial de LECTURA: una URL firmada con la de escritura, si además se
      // firmara un PUT, sería una capacidad de escritura repartida por link.
      return getSignedUrl(paraLeer, new GetObjectCommand({ Bucket, Key: clave }), {
        expiresIn: expiraEnSegundos,
      });
    },

    async eliminar(clave) {
      await paraEscribir.send(new DeleteObjectCommand({ Bucket, Key: clave }));
    },
  };
}
