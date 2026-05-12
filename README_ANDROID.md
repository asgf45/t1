# NexLoad Android App

This directory contains the source code for the NexLoad Android application, developed in Kotlin.

## Features
- **Standalone App**: No need to use a mobile browser.
- **Embedded Web View**: Loads the NexLoad web interface directly.
- **Improved UI**: Includes an "About" tab with developer information.

## How to Build and Run

### Prerequisites
- [Android Studio](https://developer.android.com/studio) Flamingo or newer.
- JDK 11 or newer.

### Steps
1. **Open Project**: Launch Android Studio and select "Open" then navigate to the `android-app` directory in this repository.
2. **Sync Gradle**: Android Studio should automatically start syncing Gradle. Wait for it to complete.
3. **Run Server**: Ensure your NexLoad Node.js server is running on your machine (e.g., `npm start`).
4. **Configure IP (if needed)**:
   - By default, the app is configured to connect to `http://10.0.2.2:3000`, which is the special IP for accessing the host machine's localhost from an Android Emulator.
   - If you are running on a physical device, update the URL in `MainActivity.kt` to your machine's local IP address (e.g., `http://192.168.1.x:3000`).
5. **Run App**: Click the "Run" button in Android Studio to build and install the app on your emulator or connected device.

## About the Developer
- **Name**: RIfat Mohsin Tapader
- **Email**: kymt83091@gmail.com
