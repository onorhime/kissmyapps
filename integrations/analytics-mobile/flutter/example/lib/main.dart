import 'package:flutter/material.dart';
import 'package:kissmyapps/kissmyapps.dart';

void main() {
  // Your project's client key, from Settings > API keys in the KissMyApps console.
  KissMyApps.start(
    const String.fromEnvironment('KMA_KEY',
        defaultValue: 'kma_pk_test_ReplaceWithYourOwnKey00'),
    options: const KissMyAppsOptions(debug: true),
  );
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KissMyApps example',
      theme: ThemeData(colorSchemeSeed: const Color(0xFFFF80BF)),
      navigatorObservers: [KissMyAppsObserver()],
      routes: {
        '/': (_) => const HomeScreen(),
        '/lesson': (_) => const LessonScreen(),
      },
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            FilledButton(
              onPressed: () => Navigator.pushNamed(context, '/lesson'),
              child: const Text('Open a lesson'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: () => KissMyApps.identify(
                'user-42',
                traits: {'plan': 'annual'},
              ),
              child: const Text('Sign in as user-42'),
            ),
            TextButton(
              onPressed: KissMyApps.reset,
              child: const Text('Sign out'),
            ),
          ],
        ),
      ),
    );
  }
}

class LessonScreen extends StatelessWidget {
  const LessonScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Lesson 3')),
      body: Center(
        child: FilledButton(
          onPressed: () {
            KissMyApps.track('lesson_completed',
                properties: {'lesson': 3, 'score': 0.92});
            Navigator.pop(context);
          },
          child: const Text('Complete the lesson'),
        ),
      ),
    );
  }
}
