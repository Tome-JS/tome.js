import { Draft, produce } from 'immer';

import deepCopy from './utils/deepCopy';

export type Primitive = string | number | boolean | null | undefined;
export type PlainObject = {
    [key: string]: Primitive | Primitive[] | PlainObject | PlainObject[];
};

export type MomentSeekFn<Moment> = (moment: Readonly<Moment>) => boolean;

export type SubscriberFn<AppState, Moment> = (values: {
    tome: Readonly<AppState>;
    moments: Readonly<Moment[]>;
    relic: Readonly<AppState>;
}) => void;

export type Keep<Moment> =
    | ['all']
    | ['none']
    | ['count', number]
    | ['first', MomentSeekFn<Moment>]
    | ['since', number]
    | ['min', Keep<Moment>[]]
    | ['max', Keep<Moment>[]];

export type TomeReducer<AppState, Moment> = (
    crystal: AppState,
    moment: Moment,
) => AppState;

export type SingleSort<Moment> = ['asc' | 'desc', keyof Moment];

export type UserOpts<AppState, Moment> = {
    initial: AppState;
    reducer: TomeReducer<AppState, Moment>;
    each?: (moment: Moment) => void;
    keep?: Keep<Moment>;
    sort?: SingleSort<Moment> | SingleSort<Moment>[];
    tsKey?: keyof Moment;
};

type InternalOpts<Moment> = {
    __ptr?: number;
    __focus?: MomentSeekFn<Moment>;
    __getTime?: () => number;
};

interface Opts<AppState, Moment>
    extends UserOpts<AppState, Moment>,
        InternalOpts<Moment> {}

function sortInPlace<Moment>(sorts: SingleSort<Moment>[], moments: Moment[]) {
    if (!sorts.length) {
        return;
    }

    const getSortVal = (
        moment: Moment,
        key: keyof Moment | ((s: Moment) => unknown),
    ) => {
        if (key instanceof Function) {
            return key(moment);
        }

        return moment[key];
    };

    moments.sort((a: Moment, b: Moment) => {
        for (let i = 0; i < sorts.length; i++) {
            const [dir, key] = sorts[i];
            const l = dir == 'asc' ? a : b;
            const r = dir == 'asc' ? b : a;

            const lVal = getSortVal(l, key),
                rVal = getSortVal(r, key);
            if (lVal === rVal) {
                continue;
            } else if (typeof lVal == 'number' && typeof rVal == 'number') {
                return lVal - rVal;
            } else if (lVal < rVal) {
                return -1;
            } else if (lVal > rVal) {
                return 1;
            }
        }

        return 0;
    });

    return moments;
}

function getKeepCount<Moment>(
    tsKey: keyof Moment,
    moments: Moment[],
    maxKeepRules: Keep<Moment>,
) {
    const [type, param] = maxKeepRules;

    switch (type) {
        case 'all':
            return moments.length;
        case 'none':
            return 0;
        case 'count': {
            return param;
        }
        case 'first':
            return (
                moments.length -
                moments.findIndex((moment: Moment) => param(moment))
            );
        case 'since': {
            const pastDistance = param;
            const ts = Date.now() - pastDistance;

            const index = moments.findIndex(
                (moment: Moment) => (moment[tsKey] as number) >= ts,
            );

            return index == -1 ? 0 : moments.length - index;
        }
        case 'min': {
            const keepCounts = param.map((m) =>
                getKeepCount(tsKey, moments, m),
            );
            return Math.min(...keepCounts);
        }
        case 'max': {
            const keepCounts = param.map((m) =>
                getKeepCount(tsKey, moments, m),
            );
            return Math.max(...keepCounts);
        }
    }
}

function fastFindIndex<Moment>(
    arr: Moment[],
    moment: Moment,
    sorts: SingleSort<Moment>[],
    lazy: boolean = false,
) {
    if (!arr.length) {
        return lazy ? 0 : -1;
    }

    let lp = 0;
    let rp = arr.length - 1;

    let ptr: number;
    let offset: number;

    do {
        for (let i = 0; i < sorts.length; i++) {
            let [dir, key] = sorts[i];

            ptr = ((rp + lp) / 2) >>> 0;
            const vl = dir == 'asc' ? moment[key] : arr[ptr][key];
            const vr = dir == 'asc' ? arr[ptr][key] : moment[key];

            if (vl < vr) {
                offset = -1;
                break;
            } else if (vl > vr) {
                offset = 1;
                break;
            }

            offset = 0;
        }

        if (offset < 0) {
            rp = ptr - 1;
        } else if (offset > 0) {
            lp = ptr + 1;
        }
    } while (offset != 0 && lp <= rp);

    if (offset == 0) {
        return ptr;
    }

    if (lazy) {
        return ptr + (offset > 0 ? 1 : 0);
    }

    return -1;
}

export default class Tome<
    AppState extends PlainObject = PlainObject,
    Moment extends PlainObject = AppState,
> {
    #opts: Readonly<Opts<AppState, Moment>>;
    #sorts: SingleSort<Moment>[];
    #state: { relic: AppState; moments: Moment[]; tome?: AppState };
    #subscribers: SubscriberFn<AppState, Moment>[] = [];

    constructor(_opts: UserOpts<AppState, Moment> | Opts<AppState, Moment>) {
        this.#opts = {
            keep: ['all'],
            each: () => {},
            __ptr: 0,
            __getTime: () => Date.now(),
            ..._opts,
        };

        if (this.#opts.sort) {
            const isMultisort = this.#opts.sort[0] instanceof Array;

            this.#sorts = (
                isMultisort ? this.#opts.sort : [this.#opts.sort]
            ) as SingleSort<Moment>[];
        } else {
            this.#sorts = [];
        }

        if (this.#opts.tsKey) {
            this.#sorts.unshift(['asc', this.#opts.tsKey]);
        }

        if (this.#opts.initial) {
            this.set(this.#opts.initial, []);
        }
    }

    subscribe(fn: SubscriberFn<AppState, Moment>) {
        this.#subscribers.push(fn);

        return () => {
            this.#subscribers = this.#subscribers.filter((s) => s !== fn);
        };
    }

    update() {
        this.#collapseIntoRelic();

        return this;
    }

    add(moments: Moment | Moment[]) {
        if (!this.ready) {
            throw new Error(
                'Attempted to add moments to a tome without initial state.',
            );
        }

        moments = moments instanceof Array ? moments : [moments];

        moments = deepCopy(moments);

        moments.forEach((moment) => {
            if (this.#opts.tsKey) {
                const ts = moment[this.#opts.tsKey];
                (moment[this.#opts.tsKey] as any) =
                    ts === undefined ? Date.now() : ts;
            }
            this.#opts.each(moment);

            const index = fastFindIndex(
                this.#state.moments,
                moment,
                this.#sorts,
                true,
            );

            this.#state.moments.splice(index, 0, moment);

            this.#reduceIntoTome(moment);
            this.#collapseIntoRelic();
        });
        // this.#state.moments.push(...moments);
        // sortInPlace(this.#sorts, this.#state.moments);

        // this.#collapseIntoRelic();
        // this.#reduceIntoTome(moments);

        this.#notifySubscribers();

        return this;
    }

    remove(fn: MomentSeekFn<Moment>) {
        this.#rebuildTome();
        throw new Error('Not yet implemented');

        this.#notifySubscribers();

        return this;
    }

    set(relic: AppState, moments: Moment[]) {
        this.#state = { relic, moments };

        sortInPlace(this.#sorts, this.#state.moments);

        this.#collapseIntoRelic();
        this.#reduceIntoTome(moments);

        this.#notifySubscribers();

        return this;
    }

    get ready() {
        const ready = this.#state && this.#state.relic && this.#state.moments;

        return ready;
    }

    get relic(): Readonly<AppState> {
        if (!this.ready) {
            throw new Error(
                'Attempted to get relic of a tome without initial state.',
            );
        }

        return this.#state.relic;
    }

    get moments(): Readonly<Moment[]> {
        if (!this.ready) {
            throw new Error(
                'Attempted to get moments of a tome without initial state.',
            );
        }

        return this.#state.moments;
    }

    get tome() {
        if (!this.ready) {
            throw new Error(
                'Attempted to get output of a tome without initial state.',
            );
        }

        if (!this.#state.tome) {
            this.#rebuildTome();
        }

        return this.#state.tome;
    }

    #collapseIntoRelic() {
        const keepCount = getKeepCount(
            this.#opts.tsKey,
            this.#state.moments,
            this.#opts.keep,
        );

        if (keepCount < this.#state.moments.length) {
            const collapseCount = this.#state.moments.length - keepCount;

            const collapsedMoments = this.#state.moments.splice(
                0,
                collapseCount,
            );

            this.#state.relic = collapsedMoments.reduce(
                (relic, moment) => this.#opts.reducer(relic, moment),
                this.#state.relic,
            );
        }
    }

    #reduceIntoTome(moments: Moment | Moment[]) {
        if (moments instanceof Array) {
            this.#state.tome = moments.reduce(
                (tome, moment) => this.#opts.reducer(tome, moment),
                this.#state.tome || deepCopy(this.#state.relic),
            );
        } else {
            this.#state.tome = this.#opts.reducer(this.#state.tome, moments);
        }
    }

    #rebuildTome() {
        delete this.#state.tome;
        this.#reduceIntoTome(this.#state.moments);
    }

    #notifySubscribers() {
        const self = this;
        const payload = {
            get tome() {
                return self.tome;
            },
            get moments() {
                return self.moments;
            },
            get relic() {
                return self.relic;
            },
        };

        this.#subscribers.forEach((fn) => fn(payload));
    }
}
