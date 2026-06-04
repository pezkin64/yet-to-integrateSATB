import React, { useState, useEffect, useRef } from 'react';
import { StatusBar, View, Text, TouchableOpacity, Alert, ScrollView, InteractionManager } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { HomeScreen } from './src/screens/HomeScreen';
import { PlaybackScreen } from './src/screens/PlaybackScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { OMRSettings } from './src/services/OMRSettings';
import { LibraryService } from './src/services/LibraryService';
import { AudioPlaybackService } from './src/services/AudioPlaybackService';
import { ThemeSettings } from './src/services/ThemeSettings';
import { getThemeById, getStatusBarStyleForTheme } from './src/theme/themes';

const DEFAULT_SOUND_FONT = require('./assets/SheetMusicScanner.sf2');

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [playbackImageUri, setPlaybackImageUri] = useState(null);
  const [playbackScoreData, setPlaybackScoreData] = useState(null);
  const [playbackScoreEntry, setPlaybackScoreEntry] = useState(null);
  const [homeGoForward, setHomeGoForward] = useState(null);
  const [themeId, setThemeId] = useState(ThemeSettings.getThemeId());
  const goForwardTimerRef = useRef(null);

  const activeTheme = getThemeById(themeId);
  const theme = activeTheme.colors;

  // Load saved OMR engine preference on startup
  useEffect(() => {
    OMRSettings.load();
    LibraryService.load();

    const preloadTask = InteractionManager.runAfterInteractions(() => {
      AudioPlaybackService.loadSoundFont(DEFAULT_SOUND_FONT, { background: true }).catch((err) => {
        console.warn('Background SoundFont preload failed:', err?.message || err);
      });
    });

    ThemeSettings.load().then((loadedTheme) => {
      if (loadedTheme?.id) {
        setThemeId(loadedTheme.id);
      }
    });

    return () => {
      if (typeof preloadTask?.cancel === 'function') {
        preloadTask.cancel();
      }
      if (goForwardTimerRef.current) {
        clearTimeout(goForwardTimerRef.current);
        goForwardTimerRef.current = null;
      }
    };
  }, []);

  const clearGoForward = () => {
    if (goForwardTimerRef.current) {
      clearTimeout(goForwardTimerRef.current);
      goForwardTimerRef.current = null;
    }
    setHomeGoForward(null);
  };

  const armGoForward = () => {
    const label =
      playbackScoreData?.metadata?.title ||
      playbackScoreEntry?.title ||
      'Last score';

    setHomeGoForward({ label });

    if (goForwardTimerRef.current) {
      clearTimeout(goForwardTimerRef.current);
    }
    goForwardTimerRef.current = setTimeout(() => {
      setHomeGoForward(null);
      goForwardTimerRef.current = null;
    }, 5 * 60 * 1000);
  };

  const handleGoForward = () => {
    clearGoForward();
    setCurrentScreen('playback');
  };

  const handlePlaybackBack = () => {
    armGoForward();
    setCurrentScreen('home');
  };

  const pickImageFromGallery = async () => {
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access gallery is required!');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      clearGoForward();
      setPlaybackImageUri(asset.uri);
      setPlaybackScoreData(null);
      setPlaybackScoreEntry(null);
      setCurrentScreen('playback');
    } catch (err) {
      console.error('Error picking image:', err?.message || err);
      Alert.alert('Error', 'Failed to pick image. Please try again.');
    }
  };

  const pickImageFromCamera = async () => {
    try {
      const permissionResult = await ImagePicker.requestCameraPermissionsAsync();

      if (!permissionResult.granted) {
        Alert.alert('Permission Required', 'Permission to access camera is required!');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      clearGoForward();
      setPlaybackImageUri(asset.uri);
      setPlaybackScoreData(null);
      setPlaybackScoreEntry(null);
      setCurrentScreen('playback');
    } catch (err) {
      console.error('Error capturing image:', err?.message || err);
      Alert.alert('Error', 'Failed to capture image. Please try again.');
    }
  };

  const handleFileSelected = (fileUri) => {
    clearGoForward();
    setPlaybackImageUri(fileUri);
    setPlaybackScoreData(null);
    setPlaybackScoreEntry(null);
    setCurrentScreen('playback');
  };

  const pickImageFromFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg', 'image/jpg'],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      const mime = String(asset.mimeType || '').toLowerCase();
      const name = String(asset.name || '').toLowerCase();
      const isSupportedImage =
        mime === 'image/png' ||
        mime === 'image/jpeg' ||
        mime === 'image/jpg' ||
        name.endsWith('.png') ||
        name.endsWith('.jpg') ||
        name.endsWith('.jpeg');

      if (!isSupportedImage) {
        Alert.alert('Unsupported File Type', 'Please select a PNG or JPEG image.');
        return;
      }

      handleFileSelected(asset.uri);
    } catch (err) {
      console.error('Error picking file:', err?.message || err);
      Alert.alert('Error', 'Failed to pick file. Please try again.');
    }
  };

  const handleScoreTapFromLibrary = (scoreData, entry) => {
    clearGoForward();
    setPlaybackImageUri(null);
    setPlaybackScoreData(scoreData);
    setPlaybackScoreEntry(entry);
    setCurrentScreen('playback');
  };

  const handlePlaybackComplete = async (scoreData, engine) => {
    // After successful playback, optionally add to library
    // (can be done manually by user, or automatically here)
    try {
      const entry = await LibraryService.addScore(
        scoreData,
        engine,
        scoreData?.metadata?.workTitle || 'Scanned Score'
      );
      console.log('Score saved to library:', entry);
    } catch (e) {
      console.warn('Failed to save to library:', e.message);
    }
  };

  const handleThemeChange = async (nextThemeId) => {
    const next = await ThemeSettings.setThemeId(nextThemeId);
    setThemeId(next.id);
  };

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <StatusBar barStyle={getStatusBarStyleForTheme(activeTheme)} backgroundColor={theme.background} />
        {currentScreen === 'home' ? (
          <HomeScreen
            onNavigate={setCurrentScreen}
            onPickFromGallery={pickImageFromGallery}
            onPickFromCamera={pickImageFromCamera}
            onPickFromFiles={pickImageFromFiles}
            goForwardState={homeGoForward}
            onGoForward={handleGoForward}
            theme={theme}
          />
        ) : currentScreen === 'playback' ? (
          <PlaybackScreen
            imageUri={playbackImageUri}
            scoreData={playbackScoreData}
            scoreEntry={playbackScoreEntry}
            onNavigateBack={handlePlaybackBack}
            onScoredSaved={handlePlaybackComplete}
            theme={theme}
          />
        ) : currentScreen === 'settings' ? (
          <SettingsScreen
            onNavigateBack={() => setCurrentScreen('home')}
            theme={theme}
            themeId={themeId}
            onThemeChange={handleThemeChange}
          />
        ) : currentScreen === 'help' ? (
          <View style={{ flex: 1, backgroundColor: theme.background }}>
            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 44, paddingBottom: 28 }}
              showsVerticalScrollIndicator={false}
            >
              <Text style={{ fontSize: 24, color: theme.ink, fontWeight: '800', marginBottom: 8 }}>Help</Text>
              <Text style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 21, marginBottom: 18 }}>
                Follow these steps to scan sheet music clearly and quickly.
              </Text>

              <Text style={{ fontSize: 18, color: theme.ink, fontWeight: '700', marginBottom: 8 }}>
                1. Scan from Camera
              </Text>
              <Text style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 21, marginBottom: 16 }}>
                • Tap Scan from Camera on Home.{"\n"}
                • Hold phone directly above one page and fill the frame.{"\n"}
                • Use good lighting and avoid shadows or glare.{"\n"}
                • Keep the page flat and straight before capturing.
              </Text>

              <Text style={{ fontSize: 18, color: theme.ink, fontWeight: '700', marginBottom: 8 }}>
                2. Scan from Photos
              </Text>
              <Text style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 21, marginBottom: 16 }}>
                • Tap Scan from Photos on Home.{"\n"}
                • Choose a sharp image with the full page visible.{"\n"}
                • Crop out background if needed so only music remains.{"\n"}
                • Best results come from bright, high-resolution photos.
              </Text>

              <Text style={{ fontSize: 18, color: theme.ink, fontWeight: '700', marginBottom: 8 }}>
                3. Scan from Files
              </Text>
              <Text style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 21, marginBottom: 16 }}>
                • Tap Scan from Files on Home.{"\n"}
                • Select PNG or JPEG for direct scanning.{"\n"}
                • If your file is PDF, convert each page to image first.{"\n"}
                • Import one page at a time for the cleanest read.
              </Text>

              <Text style={{ fontSize: 18, color: theme.ink, fontWeight: '700', marginBottom: 8 }}>
                Quick tips
              </Text>
              <Text style={{ fontSize: 14, color: theme.inkMuted, lineHeight: 21, marginBottom: 24 }}>
                • Start with simple, clean scores when possible.{"\n"}
                • Retry with a brighter or straighter image if notes are missed.{"\n"}
                • Save good scans to build your library over time.
              </Text>

              <TouchableOpacity onPress={() => setCurrentScreen('home')}>
                <Text style={{ color: theme.inkMuted, fontSize: 16, fontWeight: '600' }}>← Back to Home</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        ) : currentScreen === 'library' ? (
          <LibraryScreen
            onNavigateBack={() => setCurrentScreen('home')}
            onScoreTap={handleScoreTapFromLibrary}
            theme={theme}
          />
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}
