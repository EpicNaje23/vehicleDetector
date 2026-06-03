import { Ionicons } from '@expo/vector-icons';
import { Link, usePathname } from 'expo-router';
import { ComponentRef, forwardRef, useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, TouchableOpacity, TouchableOpacityProps, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Tab = {
  href: '/' | '/collect' | '/map' | '/account';
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  match: (pathname: string) => boolean;
};

const TABS: Tab[] = [
  {
    href: '/',
    label: 'Predict',
    icon: 'radio-outline',
    activeIcon: 'radio',
    match: (pathname) => pathname === '/',
  },
  {
    href: '/collect',
    label: 'Collect',
    icon: 'videocam-outline',
    activeIcon: 'videocam',
    match: (pathname) => pathname.startsWith('/collect'),
  },
  {
    href: '/map',
    label: 'Map',
    icon: 'map-outline',
    activeIcon: 'map',
    match: (pathname) => pathname.startsWith('/map'),
  },
  {
    href: '/account',
    label: 'Account',
    icon: 'person-circle-outline',
    activeIcon: 'person-circle',
    match: (pathname) => pathname.startsWith('/account'),
  },
];

export const BOTTOM_NAV_HEIGHT = 78;
const ACTIVE_COLOR = '#BAE6FD';
const INACTIVE_COLOR = '#64748B';
const ANIMATION_MS = 180;

export function BottomNav() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [barWidth, setBarWidth] = useState(0);
  const activeIndex = Math.max(0, TABS.findIndex((tab) => tab.match(pathname)));
  const activePosition = useSharedValue(activeIndex);
  const tabWidth = barWidth > 0 ? barWidth / TABS.length : 0;

  useEffect(() => {
    activePosition.value = withTiming(activeIndex, { duration: ANIMATION_MS });
  }, [activeIndex, activePosition]);

  const handleBarLayout = (event: LayoutChangeEvent) => {
    setBarWidth(event.nativeEvent.layout.width);
  };

  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: tabWidth > 0 ? 1 : 0,
    transform: [{ translateX: activePosition.value * tabWidth }],
  }));

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 10) }]}> 
      <View style={styles.bar} onLayout={handleBarLayout}>
        {tabWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.activePill, { width: tabWidth - 8 }, indicatorStyle]}
          />
        ) : null}
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link key={tab.href} href={tab.href as never} asChild>
              <TabButton tab={tab} active={active} />
            </Link>
          );
        })}
      </View>
    </View>
  );
}

type TabButtonProps = TouchableOpacityProps & {
  tab: Tab;
  active: boolean;
};

const TabButton = forwardRef<ComponentRef<typeof TouchableOpacity>, TabButtonProps>(function TabButton(
  { tab, active, ...touchableProps },
  ref,
) {
  const progress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, { duration: ANIMATION_MS });
  }, [active, progress]);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -progress.value },
      { scale: 1 + progress.value * 0.06 },
    ],
  }));

  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [INACTIVE_COLOR, ACTIVE_COLOR]),
    opacity: 0.72 + progress.value * 0.28,
  }));

  return (
    <TouchableOpacity ref={ref} activeOpacity={0.82} style={styles.tab} {...touchableProps}>
      <Animated.View style={[styles.tabContent, contentStyle]}>
        <Ionicons
          name={active ? tab.activeIcon : tab.icon}
          size={24}
          color={active ? '#38BDF8' : INACTIVE_COLOR}
        />
        <Animated.Text style={[styles.label, labelStyle]}>{tab.label}</Animated.Text>
      </Animated.View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: 'rgba(5, 6, 10, 0.92)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  bar: {
    minHeight: 56,
    borderRadius: 24,
    backgroundColor: '#0B1220',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    overflow: 'hidden',
  },
  activePill: {
    position: 'absolute',
    left: 4,
    top: 4,
    bottom: 4,
    borderRadius: 20,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.2)',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  label: {
    color: INACTIVE_COLOR,
    fontSize: 11,
    fontWeight: '700',
  },
});
