package com.scanconverter.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/**
 * "Salva con nome" nativo via Storage Access Framework: apre il selettore di
 * sistema (ACTION_CREATE_DOCUMENT) dove l'utente sceglie cartella e nome, poi
 * scrive i byte sull'URI restituito. Nessun permesso di storage richiesto,
 * funziona su ogni Android moderno.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

  @PluginMethod
  public void save(PluginCall call) {
    String name = call.getString("name", "documento.pdf");
    String mime = call.getString("mime", "application/pdf");
    if (call.getString("data") == null) {
      call.reject("Dati mancanti.");
      return;
    }
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mime);
    intent.putExtra(Intent.EXTRA_TITLE, name);
    startActivityForResult(call, intent, "createDocumentResult");
  }

  @ActivityCallback
  private void createDocumentResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      call.reject("cancelled");
      return;
    }
    Uri uri = result.getData().getData();
    if (uri == null) {
      call.reject("cancelled");
      return;
    }
    try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
      byte[] bytes = Base64.decode(call.getString("data"), Base64.DEFAULT);
      os.write(bytes);
      os.flush();
      JSObject ret = new JSObject();
      ret.put("uri", uri.toString());
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("Scrittura fallita: " + e.getMessage(), e);
    }
  }
}
