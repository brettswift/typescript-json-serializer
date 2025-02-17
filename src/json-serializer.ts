import {
    hasConstructor,
    isArray,
    isDateObject,
    isDateValue,
    isJsonObject,
    isNullish,
    isNumber,
    isObject,
    isString,
    tryParse,
    Type
} from './helpers';
import { JsonPropertiesMetadata, JsonPropertyMetadata, PredicateProto } from './json-property';
import { FormatPropertyNameProto, JsonSerializerOptions } from './json-serializer-options';
import { Reflection } from './reflection';

type Nullish = null | undefined;
interface Dictionary<T = any> {
    [key: string]: T;
}

export class JsonSerializer {
    public options = new JsonSerializerOptions();

    constructor(options?: Partial<JsonSerializerOptions>) {
        this.options = { ...this.options, ...options };
    }

    deserialize<T extends object>(
        value: string | object | Array<object>,
        type: Type<T> | T
    ): T | Array<T | Nullish> | Nullish {
        if (isString(value)) {
            value = tryParse(value);
        }

        if (isArray(value)) {
            return this.deserializeObjectArray(value, type);
        } else if (isObject(value)) {
            return this.deserializeObject(value, type);
        }

        this.error(
            `Fail to deserialize: value is not an Array nor an Object.\nReceived: ${JSON.stringify(
                value
            )}.`
        );

        return undefined;
    }

    deserializeObject<T extends object>(obj: string | object, type: Type<T> | T): T | Nullish {
        if (obj === null) {
            if (this.options.nullishPolicy.null === 'disallow') {
                this.error('Fail to deserialize: null is not assignable to type Object.');
            }
            return null;
        }

        if (obj === undefined) {
            if (this.options.nullishPolicy.undefined === 'disallow') {
                this.error('Fail to deserialize: undefined is not assignable to type Object.');
            }
            return undefined;
        }

        if (isString(obj)) {
            obj = tryParse(obj);
        }

        if (!isObject(obj)) {
            this.error(
                `Fail to deserialize: type '${typeof obj}' is not assignable to type 'Object'.\nReceived: ${JSON.stringify(
                    obj
                )}`
            );
            return undefined;
        }

        const instance: T = hasConstructor(type) ? new type({}) : type;
        const jsonPropertiesMetadata = this.getJsonPropertiesMetadata(instance);

        if (!jsonPropertiesMetadata) {
            return instance;
        }

        Object.keys(jsonPropertiesMetadata).forEach(key => {
            const metadata = jsonPropertiesMetadata[key];
            const property = this.deserializeProperty(instance, key, obj as object, metadata);

            if (metadata.required && isNullish(property)) {
                const instanceName = instance['constructor'].name;
                this.error(
                    `Property '${key}' is required in ${instanceName} ${JSON.stringify(obj)}.`
                );
            }

            if (this.isAllowedProperty(property)) {
                instance[key] = property;
            }
        });

        return instance;
    }

    deserializeObjectArray<T extends object>(
        array: string | Array<any>,
        type: Type<T> | T
    ): Array<T | Nullish> | Nullish {
        if (array === null) {
            if (this.options.nullishPolicy.null === 'disallow') {
                this.error('Fail to deserialize: null is not assignable to type Array.');
            }
            return null;
        }

        if (array === undefined) {
            if (this.options.nullishPolicy.undefined === 'disallow') {
                this.error('Fail to deserialize: undefined is not assignable to type Array.');
            }
            return undefined;
        }

        if (isString(array)) {
            array = tryParse(array);
        }

        if (!isArray(array)) {
            this.error(
                `Fail to deserialize: type '${typeof array}' is not assignable to type 'Array'.\nReceived: ${JSON.stringify(
                    array
                )}`
            );
            return undefined;
        }

        return array.reduce((deserializedArray, obj) => {
            const deserializedObject = this.deserializeObject(obj, type);

            if (
                !isNullish(deserializedObject) ||
                (deserializedObject === null && this.options.nullishPolicy.null !== 'remove') ||
                (deserializedObject === undefined &&
                    this.options.nullishPolicy.undefined !== 'remove')
            ) {
                deserializedArray.push(deserializedObject);
            }

            return deserializedArray;
        }, []);
    }

    serialize(value: object | Array<object>): object | Array<object> | Nullish {
        if (isArray(value)) {
            return this.serializeObjectArray(value);
        } else if (isObject(value)) {
            return this.serializeObject(value);
        }

        this.error(
            `Fail to serialize: value is not an Array nor an Object.\nReceived: ${JSON.stringify(
                value
            )}.`
        );

        return undefined;
    }

    serializeObject(instance: object): object | Nullish {
        if (instance === null) {
            if (this.options.nullishPolicy.null === 'disallow') {
                this.error('Fail to serialize: null is not assignable to type Object.');
            }
            return null;
        }

        if (instance === undefined) {
            if (this.options.nullishPolicy.undefined === 'disallow') {
                this.error('Fail to serialize: undefined is not assignable to type Object.');
            }
            return undefined;
        }

        if (!isObject(instance)) {
            return instance;
        }

        const jsonPropertiesMetadata = this.getJsonPropertiesMetadata(instance);

        if (!jsonPropertiesMetadata) {
            return instance;
        }

        const json = {};
        const instanceKeys = Object.keys(instance);

        Object.keys(jsonPropertiesMetadata).forEach(key => {
            if (instanceKeys.includes(key)) {
                const metadata = jsonPropertiesMetadata[key];

                let initialValue: any;

                if (metadata.beforeSerialize) {
                    initialValue = instance[key];
                    instance[key] = metadata.beforeSerialize(instance[key], instance);
                }

                let property = this.serializeProperty(instance, key, metadata);

                if (metadata.afterSerialize) {
                    property = metadata.afterSerialize(property, instance);
                }

                instance[key] = initialValue || instance[key];

                if (isArray(metadata.name)) {
                    metadata.name.forEach((name: string) => {
                        if (this.isAllowedProperty(property[name])) {
                            json[name] = property[name];
                        }
                    });
                } else {
                    if (this.isAllowedProperty(property)) {
                        if (
                            !metadata.isNameOverridden &&
                            this.options.formatPropertyName !== undefined
                        ) {
                            const name = this.options.formatPropertyName(metadata.name);
                            json[name] = property;
                        } else {
                            json[metadata.name] = property;
                        }
                    }
                }
            } else if (this.options.nullishPolicy.undefined !== 'remove') {
                json[key] = undefined;
            }
        });

        return json;
    }

    serializeObjectArray(array: Array<object>): Array<object | Nullish> | Nullish {
        if (array === null) {
            if (this.options.nullishPolicy.null === 'disallow') {
                this.error('Fail to serialize: null is not assignable to type Array.');
            }
            return null;
        }

        if (array === undefined) {
            if (this.options.nullishPolicy.undefined === 'disallow') {
                this.error('Fail to serialize: undefined is not assignable to type Array.');
            }
            return undefined;
        }

        if (!isArray(array)) {
            this.error(
                `Fail to serialize: type '${typeof array}' is not assignable to type 'Array'.\nReceived: ${JSON.stringify(
                    array
                )}.`
            );
            return undefined;
        }

        return array.reduce((serializedArray: Array<any>, d: any) => {
            const serializeObject = this.serializeObject(d);

            if (
                !isNullish(serializeObject) ||
                (serializeObject === null && this.options.nullishPolicy.null !== 'remove') ||
                (serializeObject === undefined && this.options.nullishPolicy.undefined !== 'remove')
            ) {
                serializedArray.push(serializeObject);
            }

            return serializedArray;
        }, []);
    }

    private deserializeProperty(
        instance: object,
        propertyKey: string,
        obj: object,
        metadata: JsonPropertyMetadata
    ): any {
        if (isNullish(obj)) {
            return undefined;
        }

        let dataSource = this.getDataSource(obj, metadata, this.options.formatPropertyName);

        if (isNullish(dataSource)) {
            return dataSource;
        }

        const type = Reflection.getType(instance, propertyKey);
        const isArrayProperty = type?.name?.toLowerCase() === 'array';
        let propertyType = metadata.type || type;

        if (metadata.beforeDeserialize) {
            dataSource = metadata.beforeDeserialize(dataSource, instance);
        }

        let property: any;
        const predicate = metadata.predicate;

        if (metadata.isDictionary) {
            property = this.deserializeDictionary(dataSource, propertyType, predicate);
        } else if (isArrayProperty) {
            property = this.deserializeArray(dataSource, propertyType, predicate);
        } else if (
            (!isJsonObject(propertyType) && !predicate) ||
            (predicate && !predicate(dataSource, obj))
        ) {
            property = this.deserializePrimitive(dataSource, propertyType.name);
        } else {
            propertyType = metadata.predicate ? metadata.predicate(dataSource, obj) : propertyType;
            property = this.deserializeObject(dataSource, propertyType);
        }

        if (metadata.afterDeserialize) {
            property = metadata.afterDeserialize(property, instance);
        }

        return property;
    }

    private deserializePrimitive(value: any, type?: string) {
        if (isNullish(type)) {
            return value;
        }

        type = type.toLowerCase();

        if (typeof value === type) {
            return value;
        }

        const error = `Fail to deserialize: type '${typeof value}' is not assignable to type '${type}'.\nReceived: ${JSON.stringify(
            value
        )}`;

        switch (type) {
            case 'string':
                const string = value.toString();

                if (string === '[object Object]') {
                    this.error(error);
                    return undefined;
                }

                return string;
            case 'number':
                if (!isNumber(value)) {
                    this.error(error);
                    return undefined;
                }

                return +value;
            case 'boolean':
                this.error(error);
                return undefined;
            case 'date':
                if (!isDateValue(value)) {
                    this.error(error);
                    return undefined;
                }

                return new Date(value);
            default:
                return value;
        }
    }

    private deserializeDictionary(
        dict: Dictionary,
        type: any,
        predicate?: PredicateProto
    ): Dictionary | undefined {
        if (!isObject(dict)) {
            this.error(
                `Fail to deserialize: type '${typeof dict}' is not assignable to type 'Dictionary'.\nReceived: ${JSON.stringify(
                    dict
                )}.`
            );
            return undefined;
        }

        const obj = {};

        Object.keys(dict).forEach(k => {
            const predicateType = predicate ? predicate(dict[k], dict) : undefined;

            if (!isJsonObject(type) && !predicateType) {
                obj[k] = this.deserializePrimitive(dict[k], typeof dict[k]);
            } else {
                obj[k] = this.deserializeObject(dict[k], predicateType || type);
            }
        });

        return obj;
    }

    private deserializeArray(array: Array<any>, type: any, predicate?: PredicateProto) {
        if (!isArray(array)) {
            this.error(
                `Fail to deserialize: type '${typeof array}' is not assignable to type 'Array'.\nReceived: ${JSON.stringify(
                    array
                )}`
            );
            return undefined;
        }

        return array.reduce((deserializedArray: Array<any>, d: any) => {
            let deserializedValue: any;
            if (!isJsonObject(type) && !predicate) {
                deserializedValue = this.deserializePrimitive(d, typeof d);
            } else {
                type = predicate ? predicate(d, array) : type;
                deserializedValue = this.deserializeObject(d, type);
            }

            if (
                !isNullish(deserializedValue) ||
                (deserializedValue === null && this.options.nullishPolicy.null !== 'remove') ||
                (deserializedValue === undefined &&
                    this.options.nullishPolicy.undefined !== 'remove')
            ) {
                deserializedArray.push(deserializedValue);
            }

            return deserializedArray;
        }, []);
    }

    private error(message: string): void {
        if (this.options.errorCallback) {
            this.options.errorCallback(message);
        }
    }

    private getClassesJsonPropertiesMetadata(
        classNames: Array<string> | undefined,
        instance: any
    ): Array<JsonPropertiesMetadata> {
        if (!classNames) {
            return [];
        }

        return classNames.reduce((result, className) => {
            const metadata = Reflection.getJsonPropertiesMetadata(instance, className);

            if (metadata) {
                result.push(metadata);
            }

            return result;
        }, [] as Array<JsonPropertiesMetadata>);
    }

    private getDataSource(
        json: object,
        { name, isNameOverridden }: JsonPropertyMetadata,
        format?: FormatPropertyNameProto
    ) {
        if (isArray(name)) {
            const data = {};
            name.forEach((value: string) => (data[value] = json[value]));
            return data;
        } else if (!isNameOverridden && format) {
            name = format(name);
            return json[name];
        }

        return json[name];
    }

    private getJsonPropertiesMetadata(instance: any): JsonPropertiesMetadata | undefined {
        const { baseClassNames } = Reflection.getJsonObjectMetadata(instance.constructor) ?? {};
        const instanceMap = Reflection.getJsonPropertiesMetadata(instance);

        if (!instanceMap && (!baseClassNames || !baseClassNames.length)) {
            return instanceMap;
        }

        if (baseClassNames && baseClassNames.length) {
            const basePropertiesMetadata = this.getClassesJsonPropertiesMetadata(
                baseClassNames,
                instance
            );
            return this.mergeJsonPropertiesMetadata(...basePropertiesMetadata, instanceMap);
        }

        return instanceMap;
    }

    private isAllowedProperty(property: any): boolean {
        if (isNullish(property)) {
            if (this.options.nullishPolicy[`${property}`] === 'disallow') {
                this.error(`Disallowed ${property} value detected.`);
                return false;
            } else if (this.options.nullishPolicy[`${property}`] === 'remove') {
                return false;
            }
        }

        return true;
    }

    private mergeJsonPropertiesMetadata(
        ...metadataMaps: Array<JsonPropertiesMetadata | undefined>
    ): JsonPropertiesMetadata {
        const jsonPropertiesMetadata: JsonPropertiesMetadata = {};

        metadataMaps.forEach(metadataMap => {
            if (metadataMap) {
                Object.keys(metadataMap).forEach(key => {
                    jsonPropertiesMetadata[key] = {
                        ...jsonPropertiesMetadata[key],
                        ...metadataMap[key]
                    };
                });
            }
        });

        return jsonPropertiesMetadata;
    }

    private serializeDictionary(dict: Dictionary): Dictionary | undefined {
        if (!isObject(dict)) {
            this.error(
                `Fail to serialize: type '${typeof dict}' is not assignable to type 'Dictionary'.\nReceived: ${JSON.stringify(
                    dict
                )}.`
            );
            return undefined;
        }

        const obj = {};
        Object.keys(dict).forEach(k => {
            obj[k] = this.serializeObject(dict[k]);
        });

        return obj;
    }

    private serializeProperty(instance: object, key: string, metadata: JsonPropertyMetadata): any {
        const property = instance[key];
        const type = Reflection.getType(instance, key);
        const isArrayProperty = type?.name?.toLocaleLowerCase() === 'array';
        const predicate = metadata.predicate;
        const propertyType = metadata.type || type;
        const isJsonObjectProperty = isJsonObject(propertyType);

        if (property && (isJsonObjectProperty || predicate)) {
            if (isArrayProperty) {
                return this.serializeObjectArray(property);
            }

            if (metadata.isDictionary) {
                return this.serializeDictionary(property);
            }

            return this.serializeObject(property);
        }

        if (propertyType?.name?.toLocaleLowerCase() === 'date' && isDateObject(property)) {
            return property.toISOString();
        }

        return property;
    }
}
