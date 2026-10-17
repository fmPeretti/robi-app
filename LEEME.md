# Robi: app nativa (Android y iPhone)

La misma app web (robot 3D, juegos, inglés/maltés) adentro de Capacitor 8, con un plugin NFC propio:

- **Android:** lee los tags siempre que la app está abierta, sin tocar ningún botón ni ver avisos del sistema. Si tocás un tag del robot con la app cerrada, la app se abre sola.
- **iPhone:** iOS solo deja leer NFC desde una hoja del sistema que se abre con un toque. Por eso aparece un botón **Scan / Skennja** abajo a la derecha. Cada vez que se abre, lee tags durante unos 60 segundos.
- **Escritura de tags:** antes de escribir, la app lee el tag y conserva todo lo que no sea del robot. Si el tag es chico (NTAG213), guarda solo el link.

## Qué necesitás

- **Node.js 22** o más nuevo.
- **Para Android:** Android Studio (la versión más reciente) y un celular Android con NFC, con la "depuración USB" activada.
- **Para iPhone:** una Mac con Xcode 26 o más nuevo y un iPhone 7 o posterior. Con un Apple ID gratis la app instalada dura 7 días; con la cuenta de desarrollador (99 USD por año) dura un año.

## 1. Configurar

1. En `robi.config.json`, poné en `webBase` el link donde subiste `robot.html`, por ejemplo `https://tuusuario.github.io/robot.html`. Ese link es el que va en los tags: lo usan los teléfonos que no tienen la app.
2. Si querés, cambiá el nombre de la app (`appName`) y el identificador (`appId`) en `capacitor.config.json`, antes del paso 2.

## 2. Instalar

En una terminal, dentro de esta carpeta:

```bash
npm install
npm run icons        # genera el ícono y la pantalla de carga desde assets/
```

### Android

```bash
npm run android
```

Esto crea el proyecto de Android, conecta el plugin NFC y abre Android Studio. Conectá el celular por USB y apretá ▶ **Run**.

Para generar un APK e instalarlo sin cable: en Android Studio, **Build → Generate App Bundles or APKs → Generate APKs**. El archivo queda en `android/app/build/outputs/apk/debug/app-debug.apk`; pasalo al celular y abrilo.

### iPhone (en una Mac)

```bash
npm run ios
```

Se abre Xcode. Ahí:

1. Elegí el target **App** → pestaña **Signing & Capabilities** → en **Team** elegí tu Apple ID.
2. Tocá **+ Capability** y agregá **Near Field Communication Tag Reading**.
3. Conectá el iPhone y apretá ▶.

## 3. Escribir los tags

Dentro de la app: ⚙ (arriba) → **Write the gadget tags**. Tocá un gadget y acercá su tag a la parte de atrás del teléfono. Repetilo con los cinco.

## Si cambiás algo de la app web

Copiá el `robot.html` nuevo a `www/index.html`, conservando las primeras líneas, las que van hasta `<body>`. Después:

```bash
npm run sync
```

## Archivos

| Archivo | Para qué es |
|---|---|
| `www/index.html` | La app (la misma que la versión web) |
| `native/android/RobiNfcPlugin.java` | Plugin NFC de Android |
| `native/ios/RobiNfc.swift` | Plugin NFC de iPhone (el script lo agrega a `AppDelegate.swift`) |
| `scripts/setup-native.mjs` | Conecta el plugin, los permisos y la apertura desde tags |
| `assets/` | Ícono y pantalla de carga |
