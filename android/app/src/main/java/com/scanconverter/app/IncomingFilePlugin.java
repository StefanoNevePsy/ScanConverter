package com.scanconverter.app;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Riceve i file condivisi verso l'app (menu Condividi / "Apri con"): cattura
 * l'URI dell'intent in ingresso (ACTION_SEND o ACTION_VIEW), e su richiesta ne
 * legge i byte restituendoli in base64 al layer web, che li inietta nella
 * pipeline come un normale caricamento.
 *
 * All'avvio a freddo il JS chiama getPending(); ad app già aperta un nuovo
 * intent emette l'evento "fileReady" e il JS richiama getPending().
 */
@CapacitorPlugin(name = "IncomingFile")
public class IncomingFilePlugin extends Plugin {

  private Uri pendingUri;

  @Override
  public void load() {
    // Intent che ha lanciato l'app (avvio a freddo tramite condivisione).
    pendingUri = extractUri(getActivity().getIntent());
  }

  @Override
  protected void handleOnNewIntent(Intent intent) {
    super.handleOnNewIntent(intent);
    Uri uri = extractUri(intent);
    if (uri != null) {
      pendingUri = uri;
      notifyListeners("fileReady", new JSObject());
    }
  }

  @PluginMethod
  public void getPending(PluginCall call) {
    Uri uri = pendingUri;
    pendingUri = null;
    if (uri == null) {
      JSObject none = new JSObject();
      none.put("available", false);
      call.resolve(none);
      return;
    }
    try {
      ContentResolver cr = getContext().getContentResolver();
      String mime = cr.getType(uri);
      if (mime == null) mime = "application/octet-stream";
      String name = queryName(uri, mime);

      try (InputStream is = cr.openInputStream(uri)) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while (is != null && (n = is.read(buf)) != -1) bos.write(buf, 0, n);
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("name", name);
        ret.put("mime", mime);
        ret.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
        call.resolve(ret);
      }
    } catch (Exception e) {
      call.reject("Lettura del file condiviso non riuscita: " + e.getMessage(), e);
    }
  }

  /** URI del file dall'intent: EXTRA_STREAM per SEND, getData() per VIEW. */
  private Uri extractUri(Intent intent) {
    if (intent == null) return null;
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action)) {
      return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }
    if (Intent.ACTION_VIEW.equals(action)) {
      return intent.getData();
    }
    return null;
  }

  /** Nome file leggibile (DISPLAY_NAME), con fallback per estensione MIME. */
  private String queryName(Uri uri, String mime) {
    String name = null;
    try (Cursor c = getContext().getContentResolver()
        .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0) name = c.getString(idx);
      }
    } catch (Exception ignored) {
    }
    if (name == null || name.isEmpty()) {
      String ext = "application/pdf".equals(mime) ? ".pdf"
          : mime != null && mime.startsWith("image/") ? "." + mime.substring(6) : "";
      name = "documento" + ext;
    }
    return name;
  }
}
