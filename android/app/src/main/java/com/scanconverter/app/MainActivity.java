package com.scanconverter.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // I plugin locali vanno registrati PRIMA di super.onCreate().
    registerPlugin(SaveFilePlugin.class);
    registerPlugin(IncomingFilePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
