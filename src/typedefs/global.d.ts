declare const __DEV__: boolean
declare const __IS_CHROME__: boolean

declare module '*.vue' {
  const component: any
  export default component
}

declare module '@grapoza/vue-tree';
