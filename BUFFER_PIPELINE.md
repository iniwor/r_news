# Pipeline de portadas WebP — El Rotativo Mex

El diseño original de `index.html` se conserva sin cambios. Las portadas son **1080 × 1350 px (4:5)** e incluyen la fotografía, el título y la **sección** editorial del generador r_news.

## Solicitud

Crear un archivo único `requests/<identificador>.json` en la rama `main`, con 1 a 3 noticias:

```json
{
  "items": [
    {
      "titulo": "Título real y verificado",
      "seccion": "Movilidad",
      "imagen": "https://ejemplo.org/imagen.jpg",
      "slug": "01-titulo"
    }
  ]
}
```

Los campos `titulo`, `seccion`, `imagen` y `slug` son obligatorios. La URL debe apuntar a una fotografía real cargable y permitida para su uso. El identificador y los slugs solo aceptan letras minúsculas, números, guiones y guiones bajos.

El workflow `.github/workflows/generar-portadas-buffer.yml` abre el generador original `https://iniwor.github.io/r_news/`, renderiza cada noticia con `window.RotativoBatch.renderFromArray`, oculta el aviso flotante `#toast` para que no se incruste en la captura y guarda un PNG de respaldo.

Después, Sharp produce un WebP comenzando en **calidad 90**, con calidades alternativas 87, 84 y 82 si es necesario para intentar mantenerse bajo **700 KiB**. Si a calidad 82 aún pesa más, se conserva esa calidad y se registra el exceso: nunca se fuerza una compresión que vuelva ilegible el texto.

El resultado de cada solicitud se publica en `portadas/<identificador>/`:

- `<slug>.webp`: archivo principal para Buffer.
- `<slug>.png`: respaldo si Buffer rechaza WebP.
- `manifest.json`: lista de imágenes, secciones, dimensiones, calidad, pesos, URLs públicas y estado.

**Buffer:** usar `portadas[].url_directa` del manifiesto, que apunta al WebP público alojado en `raw.githubusercontent.com/iniwor/r_news/main/...`. Nunca enviar el HTML del generador, un ZIP, una URL temporal o una fotografía sin diseño. Confirmar que el manifiesto corresponde exactamente a la solicitud y que Buffer registra el post como programado, sin errores.

Si falla el render, la foto no carga o el manifiesto no aparece, **no programar** esa noticia. Evitar duplicados antes de reintentar.
